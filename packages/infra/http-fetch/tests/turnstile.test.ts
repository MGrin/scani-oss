import { describe, expect, test } from 'bun:test';
import {
  isTurnstileAuthPath,
  TURNSTILE_HEADER,
  turnstileRefusal,
  verifyTurnstile,
} from '../src/turnstile';

interface Seen {
  url: string;
  body: string;
}

function fakeFetch(reply: () => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body ?? '') });
    return reply();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

describe('verifyTurnstile', () => {
  test('with no secret configured it passes without calling Cloudflare', async () => {
    const { fetchImpl, seen } = fakeFetch(ok);
    expect(await verifyTurnstile({ secret: undefined, token: null, fetchImpl })).toEqual({
      ok: true,
      checked: false,
    });
    expect(await verifyTurnstile({ secret: '', token: null, fetchImpl })).toEqual({
      ok: true,
      checked: false,
    });
    expect(seen).toEqual([]);
  });

  test('with a secret, a missing token is refused without calling Cloudflare', async () => {
    const { fetchImpl, seen } = fakeFetch(ok);
    expect(await verifyTurnstile({ secret: 's3', token: null, fetchImpl })).toEqual({
      ok: false,
      reason: 'missing-token',
    });
    expect(await verifyTurnstile({ secret: 's3', token: '  ', fetchImpl })).toEqual({
      ok: false,
      reason: 'missing-token',
    });
    expect(seen).toEqual([]);
  });

  test('a token Cloudflare accepts passes, and the secret and token are what was sent', async () => {
    const { fetchImpl, seen } = fakeFetch(ok);
    expect(await verifyTurnstile({ secret: 's3', token: 'tok', fetchImpl })).toEqual({
      ok: true,
      checked: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const form = new URLSearchParams(seen[0]?.body);
    expect(form.get('secret')).toBe('s3');
    expect(form.get('response')).toBe('tok');
  });

  test('a token Cloudflare rejects is refused', async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
          {
            status: 200,
          }
        )
    );
    expect(await verifyTurnstile({ secret: 's3', token: 'forged', fetchImpl })).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  // Fails CLOSED. The check exists because scripted signups were sending
  // mail; letting them through whenever Cloudflare cannot be asked would
  // reopen that door at exactly the moment nobody is looking.
  test.each([
    ['a network error', () => Promise.reject(new Error('ECONNRESET'))],
    ['a non-200 reply', () => new Response('bad gateway', { status: 502 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
  ])('%s refuses as unavailable', async (_name, reply) => {
    const { fetchImpl } = fakeFetch(reply as () => Promise<Response>);
    expect(await verifyTurnstile({ secret: 's3', token: 'tok', fetchImpl })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  test('the header name is lower-case, as Headers normalises it', () => {
    expect(TURNSTILE_HEADER).toBe(TURNSTILE_HEADER.toLowerCase());
  });
});

describe('isTurnstileAuthPath', () => {
  test.each([
    '/api/auth/sign-in/magic-link',
    '/api/auth/sign-up/email',
    '/api/auth/email-otp/send-verification-otp',
    '/api/auth/email-otp/request-password-reset',
    '/api/auth/forget-password',
    '/api/auth/forget-password/email-otp',
  ])('a POST to %s sends mail without a session, so it is checked', (path) => {
    expect(isTurnstileAuthPath('POST', path)).toBe(true);
  });

  // Verifying a code sends nothing; gating it would make a user solve the
  // challenge twice. The session-bound senders need a signed-in user.
  test.each([
    ['POST', '/api/auth/sign-in/email-otp'],
    ['POST', '/api/auth/magic-link/verify'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/change-email'],
    ['POST', '/api/auth/sign-out'],
    ['GET', '/api/auth/sign-in/magic-link'],
  ])('%s %s is not checked', (method, path) => {
    expect(isTurnstileAuthPath(method, path)).toBe(false);
  });
});

describe('turnstileRefusal', () => {
  const post = (path: string, token?: string) =>
    new Request(`https://api.scani.xyz${path}`, {
      method: 'POST',
      headers: token ? { [TURNSTILE_HEADER]: token } : {},
    });

  test('a path that sends no mail is never checked, even with a secret and no token', async () => {
    const { fetchImpl, seen } = fakeFetch(ok);
    expect(await turnstileRefusal(post('/api/auth/sign-in/email-otp'), 's3', fetchImpl)).toBeNull();
    expect(seen).toEqual([]);
  });

  test('with no secret a mail-sending path passes unchecked', async () => {
    const { fetchImpl, seen } = fakeFetch(ok);
    expect(
      await turnstileRefusal(post('/api/auth/sign-in/magic-link'), undefined, fetchImpl)
    ).toBeNull();
    expect(seen).toEqual([]);
  });

  test('with a secret, the header token is what gets verified', async () => {
    const { fetchImpl, seen } = fakeFetch(ok);
    expect(
      await turnstileRefusal(post('/api/auth/sign-in/magic-link', 'tok'), 's3', fetchImpl)
    ).toBeNull();
    expect(new URLSearchParams(seen[0]?.body).get('response')).toBe('tok');
  });

  test("no token is a 403, and a Cloudflare outage is a 503, not the caller's fault", async () => {
    const { fetchImpl } = fakeFetch(ok);
    expect(
      (await turnstileRefusal(post('/api/auth/email-otp/send-verification-otp'), 's3', fetchImpl))
        ?.status
    ).toBe(403);
    const down = fakeFetch(() => new Response('', { status: 502 }));
    expect(
      (await turnstileRefusal(post('/api/auth/sign-in/magic-link', 'tok'), 's3', down.fetchImpl))
        ?.status
    ).toBe(503);
  });
});
