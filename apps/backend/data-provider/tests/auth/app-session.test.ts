import { describe, expect, it } from 'bun:test';
import { AppSessionClient } from '../../src/auth/app-session';

const BASE = 'http://api.test:8080';

type Call = { url: string; headers: Headers };

function recordingFetch(respond: () => Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const incoming = () =>
  new Headers({
    cookie: '__Secure-scani-app.session_token=abc',
    authorization: 'Bearer customer-key',
    'x-forwarded-for': '203.0.113.9',
    'fly-client-ip': '203.0.113.9',
  });

describe('AppSessionClient.getSession', () => {
  it('forwards only the cookie to the app get-session route and returns the user', async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      json({
        session: { id: 's1', userId: 'u1', expiresAt: '2026-10-01T00:00:00.000Z' },
        user: { id: 'u1', email: 'a@example.com', name: 'Ann', emailVerified: true },
      })
    );
    const client = new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl });

    const result = await client.getSession(incoming());

    expect(result).toEqual({
      kind: 'user',
      user: { id: 'u1', email: 'a@example.com', name: 'Ann' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/api/auth/get-session`);
    expect([...(calls[0]?.headers.keys() ?? [])]).toEqual(['cookie']);
    expect(calls[0]?.headers.get('cookie')).toBe('__Secure-scani-app.session_token=abc');
  });

  it('maps a missing user name to null', async () => {
    const { fetchImpl } = recordingFetch(async () =>
      json({ session: { id: 's1' }, user: { id: 'u1', email: 'a@example.com' } })
    );
    const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
      incoming()
    );
    expect(result).toEqual({
      kind: 'user',
      user: { id: 'u1', email: 'a@example.com', name: null },
    });
  });

  it('reads a null user with a null session as no session', async () => {
    const { fetchImpl } = recordingFetch(async () => json({ user: null, session: null }));
    const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
      incoming()
    );
    expect(result).toEqual({ kind: 'none' });
  });

  for (const [label, body] of [
    ['{}', {}],
    ['{ user: { id: 1 } }', { user: { id: 1 } }],
    ['"x"', 'x'],
    ['a proxy JSON error', { error: 'Bad Gateway' }],
    ['a user without an email', { session: {}, user: { id: 'u1' } }],
  ] as const) {
    it(`treats ${label} as unavailable, never as no session`, async () => {
      const { fetchImpl } = recordingFetch(async () => json(body));
      const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
        incoming()
      );
      expect(result).toEqual({ kind: 'unavailable', reason: 'malformed get-session body' });
    });
  }

  it('aborts the request once the deadline passes', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const result = await new AppSessionClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      deadlineMs: 50,
    }).getSession(incoming());
    expect(result.kind).toBe('unavailable');
    await Bun.sleep(20);
    expect(signal?.aborted).toBe(true);
  });

  it('reads a null body as no session', async () => {
    const { fetchImpl } = recordingFetch(async () => json(null));
    const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
      incoming()
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('answers none without calling the app when no cookie was sent', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => json(null));
    const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
      new Headers({ authorization: 'Bearer customer-key' })
    );
    expect(result).toEqual({ kind: 'none' });
    expect(calls).toHaveLength(0);
  });

  it('is unavailable when the request rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
      incoming()
    );
    expect(result.kind).toBe('unavailable');
  });

  it('is unavailable on a 5xx', async () => {
    const { fetchImpl } = recordingFetch(async () => new Response('boom', { status: 502 }));
    const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
      incoming()
    );
    expect(result).toMatchObject({ kind: 'unavailable' });
    expect((result as { reason: string }).reason).toContain('502');
  });

  it('is unavailable when the app does not answer inside the default 3000ms', async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    const result = await new AppSessionClient({ baseUrl: BASE, fetch: fetchImpl }).getSession(
      incoming()
    );
    const elapsed = Date.now() - started;
    expect(result.kind).toBe('unavailable');
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4500);
  });
});
