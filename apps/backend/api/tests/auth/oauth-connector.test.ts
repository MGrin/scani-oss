import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { makeSignature } from 'better-auth/crypto';
import { inArray } from 'drizzle-orm';
import { createBetterAuth } from '../../src/auth/better-auth';
import {
  authorizationServerMetadata,
  ConnectedAppsService,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAuthAccessTokenVerifier,
  protectedResourceMetadata,
} from '../../src/auth/oauth-connector';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { roomyHeavyLimiter } from '../helpers/limiters';

/**
 * SC-1615: an AI client connects to /mcp the way claude.ai does — discovery,
 * dynamic registration, authorization code with PKCE, consent, token — and a
 * revoked connection stops answering. Runs the real Better-Auth plugin.
 */

const SECRET = 'test-secret-at-least-32-characters-long';
const API = 'http://localhost:3001';
const APP = 'http://localhost:5173';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = `${API}/mcp`;

const auth = createBetterAuth({
  baseURL: API,
  appUrl: APP,
  secret: SECRET,
  trustedOrigins: [APP],
  cookieDomain: undefined,
  screenshotBotSecret: 'test-screenshot-bot-secret',
});

const verifier = new OAuthAccessTokenVerifier();
const apps = new ConnectedAppsService();
const createdUsers: string[] = [];

interface Person {
  id: string;
  cookie: Headers;
}

async function person(label: string): Promise<Person> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1615-${label}-${randomUUID().slice(0, 8)}@scani.test`, name: label })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('could not create the probe user');
  createdUsers.push(user.id);
  const token = randomUUID().replaceAll('-', '');
  const now = Date.now();
  await db.insert(schema.userSessions).values({
    id: randomUUID(),
    token,
    userId: user.id,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    expiresAt: new Date(now + 86_400_000),
  });
  const signed = `${token}.${await makeSignature(token, SECRET)}`;
  return {
    id: user.id,
    cookie: new Headers({
      cookie: `scani-app.session_token=${encodeURIComponent(signed)}`,
      origin: APP,
    }),
  };
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return auth.handler(new Request(`${API}/api/auth${path}`, init));
}

async function json(path: string, body: unknown, headers: Headers): Promise<Response> {
  const h = new Headers(headers);
  h.set('content-type', 'application/json');
  return call(path, { method: 'POST', headers: h, body: JSON.stringify(body) });
}

async function register(): Promise<string> {
  const res = await call('/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(res.status).toBeLessThan(300);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

/** The full browser leg: authorize → Scani's login page → consent → code. */
async function connect(
  who: Person,
  clientId: string
): Promise<{ access: string; refresh: string }> {
  const verifierCode = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifierCode).digest('base64url');
  const authorize = new URL(`${API}/api/auth/oauth2/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: 'portfolio:read offline_access',
    state: 'st-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  })) {
    authorize.searchParams.set(k, v);
  }

  // claude.ai navigates here cross-site, so the SameSite=Strict cookie does
  // not come along: Scani sends the browser to its own login page.
  const first = await auth.handler(new Request(authorize.href, { redirect: 'manual' }));
  expect(first.status).toBe(302);
  const login = new URL(first.headers.get('location') ?? '');
  expect(login.origin + login.pathname).toBe(`${APP}/oauth/authorize`);

  // The SPA is same-site, so its call carries the session.
  const cont = await json(
    '/oauth2/continue',
    { postLogin: true, oauth_query: login.search.slice(1) },
    who.cookie
  );
  expect(cont.status).toBe(200);
  const consentUrl = new URL(((await cont.json()) as { url: string }).url);
  expect(consentUrl.origin + consentUrl.pathname).toBe(`${APP}/oauth/consent`);

  const consent = await json(
    '/oauth2/consent',
    { accept: true, oauth_query: consentUrl.search.slice(1) },
    who.cookie
  );
  expect(consent.status).toBe(200);
  const back = new URL(((await consent.json()) as { url: string }).url);
  expect(back.origin + back.pathname).toBe(CALLBACK);
  expect(back.searchParams.get('state')).toBe('st-1');
  const code = back.searchParams.get('code');
  expect(code).toBeTruthy();

  const token = await call('/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifierCode,
      resource: RESOURCE,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string; refresh_token: string };
  return { access: body.access_token, refresh: body.refresh_token };
}

function limiter() {
  return new InMemoryInflowRateLimiter({
    windowMs: 60_000,
    max: 1000,
    namespace: `rl:test-oauth-${randomUUID()}`,
  });
}

async function mcpStatus(token: string): Promise<number> {
  const deps = createMcpDeps({
    accessAllowed: async () => true,
    limiter: limiter(),
    heavyLimiter: roomyHeavyLimiter(),
  });
  const res = await handleMcpRequest(
    new Request(`${API}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    deps
  );
  return res.status;
}

let alice: Person;
let bob: Person;

beforeAll(async () => {
  alice = await person('alice');
  bob = await person('bob');
});

afterAll(async () => {
  if (createdUsers.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUsers));
  }
});

describe('discovery (SC-1615)', () => {
  test('the protected resource names Scani as its authorization server', () => {
    const meta = protectedResourceMetadata(API);
    expect(meta.resource).toBe(RESOURCE);
    expect(meta.authorization_servers).toEqual([`${API}/api/auth`]);
    expect(meta.scopes_supported).toContain('portfolio:read');
  });

  test('the authorization server advertises registration and PKCE', async () => {
    const meta = (await authorizationServerMetadata(auth)) as Record<string, unknown>;
    expect(meta.issuer).toBe(`${API}/api/auth`);
    expect(meta.registration_endpoint).toBe(`${API}/api/auth/oauth2/register`);
    expect(meta.code_challenge_methods_supported).toContain('S256');
  });

  test('an unauthenticated /mcp points the client at the metadata', async () => {
    const deps = createMcpDeps({
      accessAllowed: async () => true,
      limiter: limiter(),
      heavyLimiter: roomyHeavyLimiter(),
    });
    const res = await handleMcpRequest(
      new Request(`${API}/mcp`, { method: 'POST', body: '{}' }),
      deps
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${API}/.well-known/oauth-protected-resource/mcp"`
    );
  });
});

describe('connect, use, revoke (SC-1615)', () => {
  test('a connected client reads /mcp, and revoking it stops the token', async () => {
    const clientId = await register();
    const { access, refresh } = await connect(alice, clientId);

    expect(access.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect((await verifier.verify(access))?.userId).toBe(alice.id);
    expect(await mcpStatus(access)).toBe(200);

    const listed = await apps.list(alice.id);
    expect(listed.map((a) => a.clientId)).toContain(clientId);
    expect(listed.find((a) => a.clientId === clientId)?.name).toBe('Claude');

    expect(await apps.revoke(alice.id, clientId)).toBe(true);
    expect(await verifier.verify(access)).toBeNull();
    expect(await mcpStatus(access)).toBe(401);
    expect((await apps.list(alice.id)).map((a) => a.clientId)).not.toContain(clientId);

    const refreshed = await call('/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
      }),
    });
    expect(refreshed.status).not.toBe(200);
  });

  test("one user can neither see nor revoke another user's connection", async () => {
    const clientId = await register();
    const { access } = await connect(alice, clientId);

    expect((await apps.list(bob.id)).map((a) => a.clientId)).not.toContain(clientId);
    expect(await apps.revoke(bob.id, clientId)).toBe(false);
    expect((await verifier.verify(access))?.userId).toBe(alice.id);

    expect(await apps.revoke(alice.id, clientId)).toBe(true);
  });

  test('an unknown or malformed token is refused', async () => {
    expect(await verifier.verify(`${OAUTH_ACCESS_TOKEN_PREFIX}nope`)).toBeNull();
    expect(await verifier.verify('scani_pat_nope')).toBeNull();
    expect(await verifier.verify('')).toBeNull();
  });
});
