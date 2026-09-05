/**
 * End-to-end coverage for the `/admin/*` HMAC gate's body handling —
 * the thing that had none, which is why SC-1032 shipped. The sibling
 * files here exercise pure validators (`validateRedisReadCommands`,
 * `validateSpendOverridePayload`); nothing drove a request through
 * Elysia, so the gate hashed the empty string on every request and no
 * test could see it.
 *
 * These run a real `Elysia` on a real port and a real `fetch`, over the
 * real `createAdminGate`. The one thing they stub is the queue Redis,
 * so the gate's own logic is what is under test.
 *
 * The app under test mounts `onParse({ as: 'global' })` because that is
 * what `@elysiajs/trpc` does (`.onParse({ as: 'global' })` in its
 * plugin factory), and a global parse hook turns Elysia's body parsing
 * on for EVERY route, not only `/trpc`. That — not Elysia by itself —
 * is what drained the stream before an admin handler ran. The
 * `describe` without it is the control: the same route, the same
 * signatures, and the fix has to hold in both.
 */

// Set before the gate's module-level `loadEnv()` can cache without it.
// The "accepts a correctly signed body" case is the guard: with no
// secret the gate answers 503 and that assertion fails loudly, so a
// missing secret can never read as a pass.
process.env.JOBS_HMAC_SECRET ??= 'test_admin_hmac_secret_at_least_32_chars_long';
// `loadEnv()` parses the whole api schema, not just the one key above.
// `DATABASE_URL` already comes from the shared test preload.
process.env.REDIS_URL ??= 'redis://localhost:6380';

import { afterAll, describe, expect, it } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Elysia } from 'elysia';
import { Pipeline as IORedisPipeline } from 'ioredis';
import { createAdminGate, parseAdminRawBody } from '../../../src/presentation/http/admin-common';
import { registerAdminJobsRoutes } from '../../../src/presentation/http/admin-jobs';

const SECRET = process.env.JOBS_HMAC_SECRET as string;
const ACTOR = 'admin-app:test';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Sign exactly what `apps/frontend/admin/src/lib/clients/backend-admin.ts` signs. */
function signedHeaders(method: string, path: string, bodyHashHex: string): Record<string, string> {
  const timestamp = String(Date.now());
  const canonical = `${method}\n${path}\n${timestamp}\n${ACTOR}\n${bodyHashHex}`;
  return {
    'x-admin-hmac': createHmac('sha256', SECRET).update(canonical).digest('hex'),
    'x-admin-timestamp': timestamp,
    'x-admin-actor': ACTOR,
  };
}

/**
 * `createAdminGate` uses this for replay protection and the redis-read
 * route pipelines through it. `set` always succeeds so each request in
 * a file gets a fresh nonce — replay is covered by the gate's own
 * store, not by these cases.
 *
 * SC-1043 MADE `pipeline` RESOLVE THE COMMAND NAME. It used to accept any
 * name at all, and that is exactly why this file — which drives the real
 * route through a real Elysia — could not see that every name reaching it
 * was one ioredis rejects. A stub looser than the thing it stands in for
 * does not merely miss a bug; it certifies the route as working.
 *
 * The names are resolved against the REAL `Pipeline.prototype`
 * rather than a hand-copied list, so this cannot drift from what ioredis
 * actually defines. It stays a stub in every other respect: no socket, no
 * server, results still faked.
 */
function fakeRedis() {
  return {
    set: async () => 'OK',
    pipeline: (commands: unknown[][]) => {
      for (const [name] of commands) {
        const method = (IORedisPipeline.prototype as unknown as Record<string, unknown>)[
          name as string
        ];
        if (typeof method !== 'function') {
          // The shape ioredis fails with: it does `this[name].apply(...)`
          // at construction, so an unknown name is a TypeError, not a
          // rejected promise.
          throw new TypeError(`ioredis defines no pipeline command '${String(name)}'`);
        }
      }
      return { exec: async () => commands.map(() => [null, 0]) };
    },
    // biome-ignore lint/suspicious/noExplicitAny: stand-in for ioredis in a route test
  } as any;
}

/** The `onParse({ as: 'global' })` `@elysiajs/trpc` mounts. */
// biome-ignore lint/suspicious/noExplicitAny: Elysia hook ctx is dynamic
const trpcShapedGlobalParse = ({ request }: any) => {
  if (new URL(request.url).pathname.startsWith('/trpc')) return true;
};

const servers: { stop(): void }[] = [];

function listen(build: (app: Elysia) => void, withGlobalParse: boolean): string {
  const app = new Elysia();
  if (withGlobalParse) app.onParse({ as: 'global' }, trpcShapedGlobalParse);
  build(app);
  app.listen(0);
  servers.push(app);
  // biome-ignore lint/style/noNonNullAssertion: listen(0) has bound by now
  return `http://localhost:${app.server!.port}`;
}

afterAll(() => {
  for (const s of servers) s.stop();
});

const REDIS_READ = '/admin/jobs/redis-read';
const readBody = JSON.stringify({ commands: [['ZCARD', 'rl:coingecko']] });

// biome-ignore lint/suspicious/noExplicitAny: registerAdminJobsRoutes takes Elysia's dynamic app
const withJobsRoutes = (app: any) => registerAdminJobsRoutes(app, fakeRedis());

for (const globalParse of [true, false]) {
  const label = globalParse
    ? 'with a global onParse (what @elysiajs/trpc mounts — the SC-1032 condition)'
    : 'with no global onParse (control)';

  describe(`admin gate body hashing, ${label}`, () => {
    const base = listen(withJobsRoutes, globalParse);

    it('accepts a request signed over its REAL body', async () => {
      const res = await fetch(base + REDIS_READ, {
        method: 'POST',
        headers: {
          ...signedHeaders('POST', REDIS_READ, sha256Hex(readBody)),
          'content-type': 'application/json',
        },
        body: readBody,
      });
      // 200 means it cleared the gate AND the handler read the same
      // bytes the gate hashed. A 503 here means no JOBS_HMAC_SECRET
      // reached the gate and nothing below this line means anything.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [0] });
    });

    it('REFUSES a real body signed with the empty-body hash', async () => {
      // This is the arm that used to pass. It passing is what made the
      // signature stop covering the body at all.
      const res = await fetch(base + REDIS_READ, {
        method: 'POST',
        headers: {
          ...signedHeaders('POST', REDIS_READ, EMPTY_SHA256),
          'content-type': 'application/json',
        },
        body: readBody,
      });
      expect(res.status).toBe(401);
    });

    it('REFUSES a body swapped under an otherwise valid signature', async () => {
      const signedFor = JSON.stringify({ commands: [['ZCARD', 'rl:coingecko']] });
      const sent = JSON.stringify({ commands: [['ZCARD', 'rl:etherscan']] });
      const res = await fetch(base + REDIS_READ, {
        method: 'POST',
        headers: {
          ...signedHeaders('POST', REDIS_READ, sha256Hex(signedFor)),
          'content-type': 'application/json',
        },
        body: sent,
      });
      expect(res.status).toBe(401);
    });

    it('rejects an unparseable body only AFTER the signature over it verifies', async () => {
      const notJson = 'this is not json';
      const res = await fetch(base + REDIS_READ, {
        method: 'POST',
        headers: {
          ...signedHeaders('POST', REDIS_READ, sha256Hex(notJson)),
          'content-type': 'application/json',
        },
        body: notJson,
      });
      // 400 rather than 401: the gate verified the hash of these exact
      // bytes and handed the same bytes to the handler, which could not
      // parse them. Reaching 400 is what proves both readers agree.
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'body must be JSON' });
    });
  });
}

describe('admin gate, bodyless methods', () => {
  // A route per method, wired exactly as the real ones are: the gate
  // plus `parse: parseAdminRawBody`. The real GET/DELETE admin routes
  // need Postgres or the queue; the gate behaviour they share is here.
  const gate = createAdminGate('admin-gate-test', fakeRedis());
  const base = listen((app) => {
    app
      // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx is dynamic
      .get(
        '/admin/probe',
        // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx is dynamic
        async ({ request, body, set }: any) => {
          const actor = await gate.authenticate(request, 'GET', set, body);
          if (!actor) return gate.authFailureBody(set.status);
          return { ok: true, actor };
        },
        { parse: parseAdminRawBody }
      )
      // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx is dynamic
      .delete(
        '/admin/probe',
        // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx is dynamic
        async ({ request, body, set }: any) => {
          const actor = await gate.authenticate(request, 'DELETE', set, body);
          if (!actor) return gate.authFailureBody(set.status);
          return { ok: true, actor };
        },
        { parse: parseAdminRawBody }
      );
  }, true);

  it('accepts a GET signed with the empty-body hash', async () => {
    const res = await fetch(`${base}/admin/probe`, {
      headers: signedHeaders('GET', '/admin/probe', EMPTY_SHA256),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actor: ACTOR });
  });

  it('accepts a bodyless DELETE signed with the empty-body hash', async () => {
    const res = await fetch(`${base}/admin/probe`, {
      method: 'DELETE',
      headers: signedHeaders('DELETE', '/admin/probe', EMPTY_SHA256),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actor: ACTOR });
  });
});

describe('admin gate, body drained before the route parser', () => {
  /**
   * The defect underneath SC-1032, made reachable. `rawBodyHash` could
   * not tell "no body was sent" from "the bytes are gone", and answered
   * EMPTY_BODY_SHA256 to both — so a drained body silently dropped out
   * of the signature. Here a global hook eats the stream first; the
   * gate must REFUSE rather than hash the empty string.
   */
  const gate = createAdminGate('admin-drained-test', fakeRedis());
  const base = listen((app) => {
    app
      // biome-ignore lint/suspicious/noExplicitAny: Elysia hook ctx is dynamic
      .onParse({ as: 'global' }, async ({ request }: any) => {
        await request.text();
        return undefined;
      })
      // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx is dynamic
      .post(
        '/admin/probe',
        // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx is dynamic
        async ({ request, body, set }: any) => {
          const actor = await gate.authenticate(request, 'POST', set, body);
          if (!actor) return gate.authFailureBody(set.status);
          return { ok: true, actor };
        },
        { parse: parseAdminRawBody }
      );
  }, false);

  it('refuses instead of hashing the empty body', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const res = await fetch(`${base}/admin/probe`, {
      method: 'POST',
      headers: {
        ...signedHeaders('POST', '/admin/probe', sha256Hex(body)),
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'admin gate could not read the request body' });
  });

  it('does not accept the empty-body signature either', async () => {
    // The pre-fix code accepted exactly this. Both arms have to move:
    // refusing the real hash while still accepting the empty one would
    // be the same lost property with a different status code.
    const res = await fetch(`${base}/admin/probe`, {
      method: 'POST',
      headers: {
        ...signedHeaders('POST', '/admin/probe', EMPTY_SHA256),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(500);
  });
});

/**
 * SC-1043 at the route, rather than at the validator. `admin-jobs.test.ts`
 * asserts the validator emits names ioredis defines; this asserts the whole
 * path — sign, gate, parse, validate, pipeline — comes back 200 rather than
 * the 500 it returned on every call.
 *
 * These are the SAME route and the SAME strict `fakeRedis` the cases above
 * use. They are stated separately because the case above is named for what it
 * covers (body hashing) and a casing regression reddening it would read as an
 * SC-1032 regression to whoever hits it next.
 */
describe('SC-1043: redis-read reaches the client with a usable command name', () => {
  const base = listen(withJobsRoutes, true);

  it.each([
    ['ZCARD'],
    ['zcard'],
    ['HGETALL'],
  ])('POST with %s returns 200, not the 500 the uppercased name produced', async (name) => {
    const body = JSON.stringify({ commands: [[name, 'rl:coingecko']] });
    const res = await fetch(base + REDIS_READ, {
      method: 'POST',
      headers: {
        ...signedHeaders('POST', REDIS_READ, sha256Hex(body)),
        'content-type': 'application/json',
      },
      body,
    });
    // The 500 carried the ioredis message in `error`; assert the shape of
    // success rather than the absence of one particular string.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [0] });
  });

  it('CONTROL: the strict fakeRedis rejects a name ioredis does not define', () => {
    // Without this, a green above cannot be told from a stub that accepts
    // anything — which is the state this file was in before SC-1043.
    expect(() => fakeRedis().pipeline([['ZCARD', 'rl:coingecko']])).toThrow();
    expect(() => fakeRedis().pipeline([['zcard', 'rl:coingecko']])).not.toThrow();
  });
});
