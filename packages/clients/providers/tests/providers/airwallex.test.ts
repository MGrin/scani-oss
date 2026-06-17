import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { AirwallexProvider, mapTransaction } from '../../src/providers/airwallex';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'airwallex',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ clientId: 'cid', apiKey: 'key' }),
};

function loginResponse(): Response {
  return new Response(
    JSON.stringify({ token: 'bearer-xyz', expires_at: '2099-01-01T00:00:00.000Z' }),
    { status: 200 }
  );
}

describe('AirwallexProvider', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('declares balance + transactions + credential-validator capabilities', () => {
    const p = new AirwallexProvider(passthroughLimiter());
    expect(p.capabilities).toContain('current-balances');
    expect(p.capabilities).toContain('transactions');
    expect(p.capabilities).toContain('credential-validator');
  });

  test('canFetch* gate on airwallex', () => {
    const p = new AirwallexProvider(passthroughLimiter());
    expect(p.canFetchBalances('airwallex')).toBe(true);
    expect(p.canFetchBalances('wise')).toBe(false);
    expect(p.canFetchTransactions('airwallex')).toBe(true);
    expect(p.canFetchTransactions('wise')).toBe(false);
  });

  test('fetchBalances authenticates then maps per-currency balances, drops zeros', async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/v1/authentication/login')) {
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-client-id']).toBe('cid');
        expect(headers['x-api-key']).toBe('key');
        return loginResponse();
      }
      if (url.endsWith('/api/v1/balances/current')) {
        return new Response(
          JSON.stringify([
            { currency: 'USD', available_amount: 100, total_amount: 120 },
            { currency: 'EUR', available_amount: 0, total_amount: 0 },
            { currency: 'gbp', available_amount: 25 },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const p = new AirwallexProvider(passthroughLimiter());
    const out = await p.fetchBalances(ctx as never);
    const usd = out.find((h) => h.tokenIdentity.symbol === 'USD');
    const gbp = out.find((h) => h.tokenIdentity.symbol === 'GBP');
    // total_amount preferred over available_amount.
    expect(usd?.balance).toBe('120');
    expect(usd?.tokenType).toBe('fiat');
    expect(gbp?.balance).toBe('25');
    expect(out.find((h) => h.tokenIdentity.symbol === 'EUR')).toBeUndefined();
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new AirwallexProvider(passthroughLimiter());
    const r = await p.validateCredentials({ clientId: 'cid', apiKey: 'key' }, 'wise');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials rejects missing fields', async () => {
    const p = new AirwallexProvider(passthroughLimiter());
    const r = await p.validateCredentials({ clientId: 'cid' }, 'airwallex');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('apiKey');
  });

  test('validateCredentials returns true on successful login + balance probe', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/api/v1/authentication/login')) return loginResponse();
      if (url.endsWith('/api/v1/balances/current')) return new Response('[]', { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const p = new AirwallexProvider(passthroughLimiter());
    const r = await p.validateCredentials({ clientId: 'cid', apiKey: 'key' }, 'airwallex');
    expect(r.valid).toBe(true);
  });

  test('validateCredentials surfaces auth HTTP failure', async () => {
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    const p = new AirwallexProvider(passthroughLimiter());
    const r = await p.validateCredentials({ clientId: 'cid', apiKey: 'key' }, 'airwallex');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('401');
  });

  test('fetchTransactions pages through results, dedups, maps kinds by sign + type', async () => {
    let balanceCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/api/v1/authentication/login')) return loginResponse();
      if (url.includes('/api/v1/financial_transactions')) {
        const page = new URL(url).searchParams.get('page');
        if (page === '0') {
          balanceCalls++;
          return new Response(
            JSON.stringify({
              has_more: true,
              items: [
                {
                  id: 'tx-1',
                  amount: 1000,
                  currency: 'USD',
                  source_type: 'DEPOSIT',
                  created_at: '2025-01-10T12:00:00.000Z',
                },
                {
                  id: 'tx-2',
                  amount: -200,
                  currency: 'EUR',
                  source_type: 'PAYOUT',
                  created_at: '2025-01-11T12:00:00.000Z',
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            has_more: false,
            items: [
              {
                id: 'tx-3',
                amount: -5,
                currency: 'USD',
                source_type: 'FEE',
                created_at: '2025-01-12T12:00:00.000Z',
              },
              // Duplicate id — must be deduped.
              {
                id: 'tx-1',
                amount: 1000,
                currency: 'USD',
                source_type: 'DEPOSIT',
                created_at: '2025-01-10T12:00:00.000Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const p = new AirwallexProvider(passthroughLimiter());
    const events = await p.fetchTransactions({
      ...ctx,
      since: new Date('2025-01-01T00:00:00.000Z'),
      until: new Date('2025-02-01T00:00:00.000Z'),
    } as never);
    expect(balanceCalls).toBe(1);

    const byId = new Map(events.map((e) => [e.externalId, e]));
    expect(events).toHaveLength(3);
    expect(byId.get('tx-1')?.kind).toBe('deposit');
    expect(byId.get('tx-1')?.primary.quantity).toBe('1000');
    expect(byId.get('tx-2')?.kind).toBe('withdraw');
    expect(byId.get('tx-2')?.primary.quantity).toBe('-200');
    expect(byId.get('tx-3')?.kind).toBe('fee');
    expect(byId.get('tx-3')?.primary.quantity).toBe('-5');
  });
});

describe('AirwallexProvider.mapTransaction', () => {
  test('classifies conversions as swap_in / swap_out by sign', () => {
    const inEvt = mapTransaction({
      id: 'c1',
      amount: 50,
      currency: 'USD',
      source_type: 'CONVERSION',
      created_at: '2025-01-01T00:00:00.000Z',
    });
    expect(inEvt[0]?.kind).toBe('swap_in');
    const outEvt = mapTransaction({
      id: 'c2',
      amount: -50,
      currency: 'EUR',
      source_type: 'CONVERSION',
      created_at: '2025-01-01T00:00:00.000Z',
    });
    expect(outEvt[0]?.kind).toBe('swap_out');
  });

  test('drops zero-amount and currency-less rows', () => {
    expect(mapTransaction({ id: 'z', amount: 0, currency: 'USD', created_at: 'x' })).toHaveLength(
      0
    );
    expect(mapTransaction({ id: 'n', amount: 10, created_at: 'x' })).toHaveLength(0);
  });
});

const LIVE = process.env.SCANI_LIVE === '1';
const live = LIVE ? describe : describe.skip;

live('AirwallexProvider live (sandbox)', () => {
  test('fetchBalances + fetchTransactions against Airwallex sandbox', async () => {
    const clientId = process.env.SCANI_TESTNET_AIRWALLEX_CLIENT_ID;
    const apiKey = process.env.SCANI_TESTNET_AIRWALLEX_API_KEY;
    const baseUrl =
      process.env.SCANI_TESTNET_AIRWALLEX_BASE_URL ?? 'https://api-demo.airwallex.com';
    if (!clientId || !apiKey) {
      throw new Error(
        'SCANI_LIVE=1 requires SCANI_TESTNET_AIRWALLEX_CLIENT_ID + SCANI_TESTNET_AIRWALLEX_API_KEY'
      );
    }
    const p = new AirwallexProvider(passthroughLimiter(), baseUrl);
    const liveCtx = {
      institutionCode: 'airwallex',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({ clientId, apiKey }),
    };
    const balances = await p.fetchBalances(liveCtx as never);
    expect(Array.isArray(balances)).toBe(true);
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
