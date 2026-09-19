import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createOutflowLimiter } from '@scani/rate-limiter';
import type { ProviderCredentialStatus } from '../../src/core/credential-report';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { SaltEdgeProvider, saltedgeFactory } from '../../src/providers/saltedge';
import { SaltEdgeClient, signatureBase } from '../../src/providers/saltedge/client';

const limiter = () => createOutflowLimiter({ maxRequests: 1000, windowMs: 1000 });
const BASE = 'https://www.saltedge.com';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake Salt Edge: routes by path, pages by `from_id`, records every call. */
function fakeApi(routes: Record<string, unknown[][]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const key = `${url.pathname}?${[...url.searchParams]
      .filter(([k]) => k !== 'from_id')
      .map(([k, v]) => `${k}=${v}`)
      .join('&')}`;
    const pages = routes[key];
    if (!pages)
      return new Response(JSON.stringify({ error: { class: 'NotFound' } }), { status: 404 });
    const index = Number(url.searchParams.get('from_id') ?? 0);
    const next = index + 1 < pages.length ? String(index + 1) : null;
    return new Response(
      JSON.stringify({ data: pages[index], meta: { next_id: next, next_page: null } }),
      { status: 200 }
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const creds = { appId: 'app-1', secret: 'secret-1' };

function ctx(customerId = 'cust-1') {
  return {
    institutionCode: 'saltedge',
    credentialsRef: { userId: 'u1', institutionId: 'i1' },
    resolveCredentials: async () => ({ customerId }),
  } as never;
}

describe('SaltEdgeClient', () => {
  test('every request carries App-id and Secret', async () => {
    const api = fakeApi({ '/api/v6/connections?customer_id=c': [[]] });
    const client = new SaltEdgeClient(creds, limiter(), {
      baseUrl: BASE,
      fetchImpl: api.fetchImpl,
    });
    await client.list('/api/v6/connections', { customer_id: 'c' });
    expect(api.calls[0]?.headers['app-id']).toBe('app-1');
    expect(api.calls[0]?.headers.secret).toBe('secret-1');
    expect(api.calls[0]?.headers.signature).toBeUndefined();
  });

  test('follows next_id until the last page', async () => {
    const api = fakeApi({
      '/api/v6/accounts?connection_id=k': [[{ id: 'a' }], [{ id: 'b' }], [{ id: 'c' }]],
    });
    const client = new SaltEdgeClient(creds, limiter(), {
      baseUrl: BASE,
      fetchImpl: api.fetchImpl,
    });
    const all = await client.list<{ id: string }>('/api/v6/accounts', { connection_id: 'k' });
    expect(all.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(api.calls).toHaveLength(3);
  });

  test('with a private key, signs Expires-at|METHOD|url|body with RSA-SHA256', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const api = fakeApi({ '/api/v6/connections?customer_id=c': [[]] });
    const client = new SaltEdgeClient({ ...creds, privateKeyPem: pem }, limiter(), {
      baseUrl: BASE,
      fetchImpl: api.fetchImpl,
      now: () => 1_700_000_000_000,
    });
    await client.list('/api/v6/connections', { customer_id: 'c' });
    const call = api.calls[0];
    expect(call?.headers['expires-at']).toBe(String(1_700_000_000 + 3000));
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signatureBase(call?.headers['expires-at'] ?? '', 'GET', call?.url ?? '', ''));
    expect(verifier.verify(publicKey, call?.headers.signature ?? '', 'base64')).toBe(true);
  });

  test('a non-2xx answer throws rather than reading as empty', async () => {
    const api = fakeApi({});
    const client = new SaltEdgeClient(creds, limiter(), {
      baseUrl: BASE,
      fetchImpl: api.fetchImpl,
    });
    await expect(client.list('/api/v6/connections', { customer_id: 'x' })).rejects.toThrow();
  });
});

describe('SaltEdgeProvider', () => {
  const routes = {
    '/api/v6/connections?customer_id=cust-1': [
      [
        { id: 'k1', status: 'active', provider_name: 'Fake Bank' },
        { id: 'k2', status: 'inactive', provider_name: 'Expired Bank' },
      ],
    ],
    '/api/v6/accounts?connection_id=k1': [
      [
        { id: 'a1', name: 'Current', nature: 'account', balance: 1500.5, currency_code: 'EUR' },
        { id: 'a2', name: 'Savings', nature: 'savings', balance: 100, currency_code: 'eur' },
        { id: 'a3', name: 'Card', nature: 'credit_card', balance: -40, currency_code: 'GBP' },
      ],
    ],
    '/api/v6/transactions?connection_id=k1&account_id=a1': [
      [
        {
          id: 't1',
          account_id: 'a1',
          made_on: '2026-09-01',
          amount: -50,
          currency_code: 'EUR',
          description: 'Coffee',
          status: 'posted',
          extra: {},
        },
        {
          id: 't2',
          account_id: 'a1',
          made_on: '2026-09-02',
          amount: 2000,
          currency_code: 'EUR',
          description: 'Salary',
          status: 'posted',
          extra: {},
        },
        {
          id: 't3',
          account_id: 'a1',
          made_on: '2026-09-03',
          amount: -9,
          currency_code: 'EUR',
          description: 'Pending',
          status: 'pending',
          extra: {},
        },
      ],
      [
        {
          id: 't4',
          account_id: 'a1',
          made_on: '2025-01-01',
          amount: -1,
          currency_code: 'EUR',
          description: 'Old',
          status: 'posted',
          extra: {},
        },
      ],
    ],
    '/api/v6/transactions?connection_id=k1&account_id=a2': [[]],
    '/api/v6/transactions?connection_id=k1&account_id=a3': [[]],
  };

  const provider = (api = fakeApi(routes)) =>
    new SaltEdgeProvider(
      new SaltEdgeClient(creds, limiter(), { baseUrl: BASE, fetchImpl: api.fetchImpl })
    );

  test('claims the saltedge institution only when keyed', () => {
    expect(provider().canFetchBalances('saltedge')).toBe(true);
    expect(provider().canFetchTransactions('wise')).toBe(false);
    expect(new SaltEdgeProvider(null).canFetchBalances('saltedge')).toBe(false);
    expect(new SaltEdgeProvider(null).canFetchTransactions('saltedge')).toBe(false);
  });

  test('balances: active connections only, summed per currency, fiat, non-positive skipped', async () => {
    const api = fakeApi(routes);
    const snapshots = await provider(api).fetchBalances(ctx());
    expect(snapshots.map((s) => [s.externalId, s.balance, s.tokenType])).toEqual([
      ['EUR', '1600.5', 'fiat'],
    ]);
    expect(api.calls.some((c) => c.url.includes('connection_id=k2'))).toBe(false);
  });

  test('no customer id means nothing to fetch, and nothing is asked', async () => {
    const api = fakeApi(routes);
    expect(await provider(api).fetchBalances(ctx(''))).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });

  test('transactions: posted rows in the window, signed into deposit and withdraw', async () => {
    const events = await provider().fetchTransactions({
      ...(ctx() as object),
      since: new Date('2026-01-01T00:00:00Z'),
      until: new Date('2026-10-01T00:00:00Z'),
    } as never);
    expect(events.map((e) => [e.externalId, e.kind, e.primary.quantity])).toEqual([
      ['t1', 'withdraw', '-50'],
      ['t2', 'deposit', '2000'],
    ]);
    expect(events[0]?.primary.tokenIdentity.symbol).toBe('EUR');
    expect(events[0]?.occurredAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('saltedgeFactory', () => {
  async function run(env: Record<string, string | undefined>) {
    const recorded: ProviderCredentialStatus[] = [];
    const provider = (await saltedgeFactory({
      redis: null,
      env,
      rateLimiterRegistry: new RateLimiterRegistry(),
      reportCredentialStatus: (s) => recorded.push(s),
    })) as SaltEdgeProvider;
    return { provider, recorded };
  }

  test('unkeyed: reports it, and never claims the institution', async () => {
    const { provider, recorded } = await run({});
    expect(recorded).toEqual([
      expect.objectContaining({ provider: 'saltedge', envVar: 'SALTEDGE_APP_ID', keyed: false }),
    ]);
    expect(provider.canFetchBalances('saltedge')).toBe(false);
  });

  test('keyed with an app id and a secret: claims it', async () => {
    const { provider, recorded } = await run({ SALTEDGE_APP_ID: 'a', SALTEDGE_SECRET: 's' });
    expect(recorded[0]?.keyed).toBe(true);
    expect(provider.canFetchBalances('saltedge')).toBe(true);
  });

  test('an app id without its secret is not keyed', async () => {
    const { recorded } = await run({ SALTEDGE_APP_ID: 'a' });
    expect(recorded[0]?.keyed).toBe(false);
  });
});
