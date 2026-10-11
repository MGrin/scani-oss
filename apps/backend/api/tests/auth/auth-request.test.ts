import { describe, expect, test } from 'bun:test';
import { trpc } from '@elysiajs/trpc';
import { Elysia } from 'elysia';
import { rebuildAuthRequest } from '../../src/auth/auth-request';
import { appRouter } from '../../src/presentation/router';
import { createContext } from '../../src/presentation/trpc';

// SC-1615. The OAuth token endpoint takes a form body. Elysia parses it to an
// object before /api/auth/* runs, so the rebuilt request must re-encode it as
// a form; this posts through Elysia with the tRPC plugin mounted, as index.ts.

function app() {
  return new Elysia()
    .use(trpc(appRouter, { createContext, endpoint: '/trpc' }))
    .all('/api/auth/*', async ({ request, body, headers }) => {
      const rebuilt = rebuildAuthRequest(request, body, headers, '203.0.113.9');
      return {
        contentType: rebuilt.headers.get('content-type'),
        text: await rebuilt.text(),
      };
    });
}

describe('rebuildAuthRequest (SC-1615)', () => {
  test('a form body goes back to Better-Auth as a form', async () => {
    const res = await app().handle(
      new Request('http://localhost/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb',
      })
    );
    const out = (await res.json()) as { contentType: string; text: string };
    expect(out.contentType).toStartWith('application/x-www-form-urlencoded');
    const form = new URLSearchParams(out.text);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('abc');
    expect(form.get('redirect_uri')).toBe('https://claude.ai/cb');
  });

  test('a JSON body stays JSON (control)', async () => {
    const res = await app().handle(
      new Request('http://localhost/api/auth/oauth2/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept: true }),
      })
    );
    const out = (await res.json()) as { contentType: string; text: string };
    expect(out.contentType).toStartWith('application/json');
    expect(JSON.parse(out.text)).toEqual({ accept: true });
  });
});
