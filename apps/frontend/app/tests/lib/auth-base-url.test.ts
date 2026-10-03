import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAuthClient } from 'better-auth/client';
import { resolveAuthBaseUrl } from '../../src/lib/api-base-url';

/**
 * SC-1520. The api serves Better-Auth at `<its origin>/api/auth/*`. The
 * published `scani/frontend-app` image is built with `VITE_API_URL=/api` and
 * its nginx strips `/api/` before proxying, so a client that used the API base
 * as its auth base asked for `/api/get-session` and `/api/sign-in/magic-link`,
 * which reached the api as `/get-session` — 404. Nobody could sign in to a
 * self-hosted install from a browser, and the emailed link 404'd too.
 *
 * Asked of the real Better-Auth client rather than of our helper alone: the
 * defect was in how Better-Auth treats a base URL that carries a path, so a
 * test of the string we hand it would have passed over it.
 */
async function sessionUrl(configured: string, origin: string): Promise<string> {
  let seen = '';
  const client = createAuthClient({
    baseURL: resolveAuthBaseUrl(configured, origin),
    fetchOptions: {
      customFetchImpl: async (input) => {
        seen = String(input instanceof Request ? input.url : input);
        return Response.json(null);
      },
    },
  });
  await client.getSession();
  return seen;
}

describe('the URL the auth client actually calls', () => {
  test('production is unchanged: the api origin, under /api/auth', async () => {
    expect(await sessionUrl('https://api.scani.xyz', 'https://app.scani.xyz')).toBe(
      'https://api.scani.xyz/api/auth/get-session'
    );
  });

  test('local dev is unchanged', async () => {
    expect(await sessionUrl('http://localhost:3011', 'http://localhost:5173')).toBe(
      'http://localhost:3011/api/auth/get-session'
    );
  });

  test('the self-host image calls its own origin under /api/auth, which nginx passes through', async () => {
    expect(await sessionUrl('/api', 'http://localhost:8080')).toBe(
      'http://localhost:8080/api/auth/get-session'
    );
    expect(await sessionUrl('/api', 'https://scani.example.org')).toBe(
      'https://scani.example.org/api/auth/get-session'
    );
  });
});

describe('the image nginx keeps the /api/auth prefix', () => {
  const template = readFileSync(resolve(import.meta.dir, '../../nginx.conf.template'), 'utf8');

  test('a /api/auth/ location proxies to the same path on the api, unstripped', () => {
    const block = template.match(/location \/api\/auth\/ \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(block).toContain('proxy_pass         ${API_UPSTREAM}/api/auth/;');
  });

  test('CONTROL: every other /api/ path is still stripped', () => {
    const block = template.match(/location \/api\/ \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(block).toContain('proxy_pass         ${API_UPSTREAM}/;');
  });
});
