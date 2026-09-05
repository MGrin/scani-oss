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
import { db } from '@scani/db/connection';
import { adminAuditLog } from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { SCHEDULED_JOB_DESCRIPTORS } from '@scani/jobs';
import { QueueClient } from '@scani/queue';
import { and, eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { Pipeline as IORedisPipeline } from 'ioredis';
import { Container } from 'typedi';
import { createAdminGate, parseAdminRawBody } from '../../../src/presentation/http/admin-common';
import { registerAdminJobsRoutes } from '../../../src/presentation/http/admin-jobs';

restoreContainerAfterAll();

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

/**
 * SC-1045: the two admin WRITE routes — `/admin/schedules/:name/run` and
 * `/admin/dlq/:id/replay` — through the same real Elysia, real port, real
 * gate this file already stands up.
 *
 * WHY THESE LIVE HERE AND NOT IN A NEW FILE. Both are writes behind the
 * gate SC-1032 had just repaired, and a route whose signature does not
 * cover its body is exactly the defect that closed. A parallel harness
 * would be a second thing to keep in step with the gate, and the first
 * time it drifted it would certify a route the real gate rejects.
 *
 * THE QUEUE IS STUBBED AND THE AUDIT LOG IS NOT. The queue stub models
 * BullMQ's duplicate-id behaviour rather than accepting everything (see
 * `fakeQueueClient`), on the same reasoning the `fakeRedis` above carries:
 * a stub looser than the thing it stands in for certifies the route as
 * working. The audit assertions read the REAL `admin_audit_log` through
 * the real `audit()` — its `catch {}` swallows every failure by design, so
 * a route that returns 200 while its audit write dies looks identical from
 * the outside. That is why the assertion is on the ROW.
 */

/** Actor unique to this run, so the audit queries below cannot pick up another file's rows. */
const WRITE_ACTOR = `admin-app:sc1045-${process.pid}-${Date.now()}`;

function signedFor(
  method: string,
  path: string,
  bodyHashHex: string,
  actor: string = WRITE_ACTOR
): Record<string, string> {
  const timestamp = String(Date.now());
  const canonical = `${method}\n${path}\n${timestamp}\n${actor}\n${bodyHashHex}`;
  return {
    'x-admin-hmac': createHmac('sha256', SECRET).update(canonical).digest('hex'),
    'x-admin-timestamp': timestamp,
    'x-admin-actor': actor,
  };
}

interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  updateData(next: Record<string, unknown>): Promise<void>;
}

/**
 * A queue that refuses a second job under an id it already holds, because
 * that is what BullMQ's Postgres backend does: `add_job` ends
 * `ON CONFLICT (queue, id) DO NOTHING` and returns the existing id
 * (`bullmq@6.2.0`, `dist/cjs/postgres/migrations/0002_functions.sql`).
 * That property IS the held-down-button defence for both routes, so a
 * stub that quietly appended a second job would make the storm tests pass
 * over a route with no defence at all.
 */
function fakeQueue(seed: FakeJob[] = []) {
  const jobs = new Map<string, FakeJob>(seed.map((j) => [j.id, j]));
  const addCalls: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  return {
    jobs,
    addCalls,
    async getJob(id: string) {
      return jobs.get(id);
    },
    async add(name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) {
      addCalls.push({ name, data, opts });
      const id = String(opts.jobId ?? `auto-${jobs.size}`);
      const existing = jobs.get(id);
      if (existing) return existing;
      const job = makeJob(id, name, data);
      jobs.set(id, job);
      return job;
    },
  };
}

function makeJob(id: string, name: string, data: Record<string, unknown>): FakeJob {
  const job: FakeJob = {
    id,
    name,
    data,
    async updateData(next: Record<string, unknown>) {
      job.data = next;
    },
  };
  return job;
}

type FakeQueue = ReturnType<typeof fakeQueue>;

/** Stand in for the `QueueClient` @Service the routes resolve at request time. */
function installQueues(main: FakeQueue, dlq: FakeQueue): void {
  Container.set(QueueClient, { get: () => main, getDlq: () => dlq } as unknown as QueueClient);
}

/**
 * Audit rows one actor wrote for one action+resource.
 *
 * Scoped by ACTOR and not only by action+resource, because a schedule's
 * resource is its NAME — the same for every case in the block below — so an
 * unscoped query counts the rows earlier cases in the same run wrote and a
 * `toHaveLength(1)` reads 2. Each case that asserts a row therefore signs as
 * its own actor.
 */
async function auditRows(action: string, resource: string, actor: string = WRITE_ACTOR) {
  return db
    .select({
      actor: adminAuditLog.actor,
      action: adminAuditLog.action,
      resource: adminAuditLog.resource,
      result: adminAuditLog.result,
      details: adminAuditLog.details,
    })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.actor, actor),
        eq(adminAuditLog.action, action),
        eq(adminAuditLog.resource, resource)
      )
    );
}

// A real registered schedule, taken from the registry rather than typed in —
// a literal here would drift exactly as the admin app's six-name list did.
const A_SCHEDULE = SCHEDULED_JOB_DESCRIPTORS[0];

describe('SC-1045: POST /admin/schedules/:name/run', () => {
  const base = listen(withJobsRoutes, true);
  const runPath = (name: string) => `/admin/schedules/${encodeURIComponent(name)}/run`;

  const post = (name: string, actor: string = WRITE_ACTOR) =>
    fetch(base + runPath(name), {
      method: 'POST',
      headers: signedFor('POST', runPath(name), EMPTY_SHA256, actor),
    });

  it('CONTROL: the registry names a schedule and it is locked', () => {
    // Both halves of the claim the route rests on. Without the first, every
    // "unknown schedule" assertion below passes for the wrong reason; without
    // the second, "the manual path goes through the advisory lock" is a
    // sentence about a descriptor that does not ask for one.
    expect(SCHEDULED_JOB_DESCRIPTORS.length).toBeGreaterThan(20);
    expect(typeof A_SCHEDULE?.name).toBe('string');
    expect(A_SCHEDULE?.lockName).toBeTruthy();
  });

  it('enqueues the schedule by its OWN name, which is what routes it through the advisory lock', async () => {
    const main = fakeQueue();
    installQueues(main, fakeQueue());

    const res = await post(A_SCHEDULE.name);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: A_SCHEDULE.name,
      jobId: `admin-run:${A_SCHEDULE.name}`,
    });

    // The lock is the worker's: `WorkerClient.runJob` dispatches on
    // `job.name` alone and `ScheduledJobProcessor.process` wraps `handle`
    // in `JobLock.withLock(descriptor.lockName)`. So a manual fire is
    // subject to it precisely when it arrives on the queue under the
    // descriptor's own name, with the `data: {}` `JobScheduler.upsertAll`
    // arms — which is what this asserts. Running the handler inline here
    // would go around the lock entirely.
    expect(main.addCalls).toHaveLength(1);
    expect(main.addCalls[0]?.name).toBe(A_SCHEDULE.name);
    expect(main.addCalls[0]?.data).toEqual({});
  });

  it('writes an audit ROW, not just a 200', async () => {
    const name = A_SCHEDULE.name;
    const actor = `${WRITE_ACTOR}:run-audit`;
    installQueues(fakeQueue(), fakeQueue());
    expect((await post(name, actor)).status).toBe(200);

    // `audit()` swallows every failure (`admin-common.ts`'s `catch`), so a
    // 200 says nothing about whether the trail recorded anything. Two
    // months of an empty tamper-evident log is what that cost (SC-1032).
    const rows = await auditRows('schedules.run', name, actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('success');
    expect((rows[0]?.details as { jobId?: string })?.jobId).toBe(`admin-run:${name}`);
  });

  it('REFUSES a second fire while one is still queued, and enqueues nothing', async () => {
    const main = fakeQueue();
    installQueues(main, fakeQueue());

    expect((await post(A_SCHEDULE.name)).status).toBe(200);
    const second = await post(A_SCHEDULE.name);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toContain('already queued');

    // The held-down button. One add, one job — and the id is deterministic,
    // so even a racing add BullMQ did accept would collapse onto the same
    // row rather than queueing a second real fire.
    expect(main.addCalls).toHaveLength(1);
    expect(main.jobs.size).toBe(1);
  });

  it('audits the refusal as `denied`', async () => {
    const name = A_SCHEDULE.name;
    const actor = `${WRITE_ACTOR}:run-denied`;
    installQueues(fakeQueue(), fakeQueue());
    expect((await post(name, actor)).status).toBe(200);
    expect((await post(name, actor)).status).toBe(409);

    const denied = (await auditRows('schedules.run', name, actor)).filter(
      (r) => r.result === 'denied'
    );
    expect(denied).toHaveLength(1);
  });

  it('404s a name the registry does not carry, and audits it', async () => {
    const actor = `${WRITE_ACTOR}:run-404`;
    installQueues(fakeQueue(), fakeQueue());
    const res = await post('not-a-real-schedule', actor);
    expect(res.status).toBe(404);

    const rows = await auditRows('schedules.run', 'not-a-real-schedule', actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('failure');
  });

  it('REFUSES a signature made for a different schedule', async () => {
    // The gate covers method+path, so a signature minted for one schedule
    // must not fire another. Nothing else on this route carries a body,
    // which is what makes the path half load-bearing here.
    installQueues(fakeQueue(), fakeQueue());
    const res = await fetch(base + runPath(A_SCHEDULE.name), {
      method: 'POST',
      headers: signedFor('POST', runPath('some-other-schedule'), EMPTY_SHA256),
    });
    expect(res.status).toBe(401);
  });
});

describe('SC-1045: POST /admin/dlq/:id/replay', () => {
  const base = listen(withJobsRoutes, true);
  const replayPath = (id: string) => `/admin/dlq/${encodeURIComponent(id)}/replay`;

  const post = (id: string) =>
    fetch(base + replayPath(id), {
      method: 'POST',
      headers: signedFor('POST', replayPath(id), EMPTY_SHA256),
    });

  /** What `WorkerClient` writes into the DLQ on terminal failure. */
  const dlqEntry = (id: string, extra: Record<string, unknown> = {}) =>
    makeJob(id, 'holding-price-update', {
      originalJobId: `orig-${id}`,
      originalName: 'holding-price-update',
      data: { holdingCount: 3 },
      failedReason: 'upstream timeout',
      attemptsMade: 3,
      ...extra,
    });

  it('CONTROL: the fake queue refuses a duplicate id, as BullMQ does', () => {
    // Without this the storm assertions below cannot be told from a stub
    // that appends whatever it is handed — which would make a route with
    // no defence at all read green.
    const q = fakeQueue();
    return (async () => {
      const a = await q.add('x', {}, { jobId: 'same' });
      const b = await q.add('x', {}, { jobId: 'same' });
      expect(q.jobs.size).toBe(1);
      expect(b).toBe(a);
      await q.add('x', {}, { jobId: 'other' });
      expect(q.jobs.size).toBe(2);
    })();
  });

  it('re-enqueues the original job onto the main queue', async () => {
    const id = `dlq-ok-${Date.now()}`;
    const main = fakeQueue();
    installQueues(main, fakeQueue([dlqEntry(id)]));

    const res = await post(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dlqJobId: id,
      name: 'holding-price-update',
      jobId: `dlq-replay:${id}`,
    });
    expect(main.addCalls).toHaveLength(1);
    expect(main.addCalls[0]?.name).toBe('holding-price-update');
    expect(main.addCalls[0]?.data).toEqual({ holdingCount: 3 });
    expect(main.addCalls[0]?.opts).toEqual({ jobId: `dlq-replay:${id}` });
  });

  it('writes an audit ROW, not just a 200', async () => {
    const id = `dlq-audit-${Date.now()}`;
    installQueues(fakeQueue(), fakeQueue([dlqEntry(id)]));
    expect((await post(id)).status).toBe(200);

    const rows = await auditRows('dlq.replay', id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('success');
    expect((rows[0]?.details as { name?: string })?.name).toBe('holding-price-update');
  });

  it('stamps the DLQ entry so the refusal below has something to read', async () => {
    const id = `dlq-stamp-${Date.now()}`;
    const dlq = fakeQueue([dlqEntry(id)]);
    installQueues(fakeQueue(), dlq);
    expect((await post(id)).status).toBe(200);

    const stamped = dlq.jobs.get(id)?.data as Record<string, unknown>;
    expect(typeof stamped.replayedAt).toBe('string');
    expect(stamped.replayedBy).toBe(WRITE_ACTOR);
    // The post-mortem detail survives the stamp — an operator still needs it.
    expect(stamped.failedReason).toBe('upstream timeout');
  });

  it('REFUSES an entry it has already replayed, and enqueues nothing', async () => {
    const id = `dlq-twice-${Date.now()}`;
    const main = fakeQueue();
    installQueues(main, fakeQueue([dlqEntry(id)]));

    expect((await post(id)).status).toBe(200);
    const second = await post(id);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('already replayed');
    expect(main.addCalls).toHaveLength(1);
  });

  it('audits the refusal as `denied`', async () => {
    const id = `dlq-denied-${Date.now()}`;
    installQueues(fakeQueue(), fakeQueue([dlqEntry(id)]));
    expect((await post(id)).status).toBe(200);
    expect((await post(id)).status).toBe(409);

    const denied = (await auditRows('dlq.replay', id)).filter((r) => r.result === 'denied');
    expect(denied).toHaveLength(1);
  });

  it('runs the job ONCE even when the stamp never landed — the storm case', async () => {
    // The `replayedAt` stamp is legibility; the deterministic job id is the
    // guarantee. Model the stamp failing (it is a separate write, after the
    // enqueue) and the second click must still not duplicate the work.
    const id = `dlq-storm-${Date.now()}`;
    const main = fakeQueue();
    const entry = dlqEntry(id);
    entry.updateData = async () => {
      throw new Error('stamp write failed');
    };
    installQueues(main, fakeQueue([entry]));

    await post(id);
    await post(id);
    await post(id);

    // Three clicks, three adds attempted, ONE job — the id collapses them,
    // exactly as `add_job`'s `ON CONFLICT (queue, id) DO NOTHING` does.
    expect(main.jobs.size).toBe(1);
    expect([...main.jobs.keys()]).toEqual([`dlq-replay:${id}`]);
  });

  it('404s an id the DLQ does not hold, and audits it', async () => {
    installQueues(fakeQueue(), fakeQueue());
    const res = await post('no-such-dlq-entry');
    expect(res.status).toBe(404);

    const rows = await auditRows('dlq.replay', 'no-such-dlq-entry');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('failure');
  });

  it('400s an entry carrying no originalName rather than enqueueing a nameless job', async () => {
    const id = `dlq-noname-${Date.now()}`;
    const main = fakeQueue();
    installQueues(main, fakeQueue([makeJob(id, 'x', { data: { a: 1 } })]));

    const res = await post(id);
    expect(res.status).toBe(400);
    expect(main.addCalls).toHaveLength(0);
    expect((await auditRows('dlq.replay', id))[0]?.result).toBe('failure');
  });

  it('REFUSES a signature made for a different DLQ id', async () => {
    const id = `dlq-sig-${Date.now()}`;
    installQueues(fakeQueue(), fakeQueue([dlqEntry(id)]));
    const res = await fetch(base + replayPath(id), {
      method: 'POST',
      headers: signedFor('POST', replayPath('some-other-id'), EMPTY_SHA256),
    });
    expect(res.status).toBe(401);
  });
});
