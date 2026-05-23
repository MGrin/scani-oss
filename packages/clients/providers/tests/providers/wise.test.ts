import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { WiseProvider } from '../../src/providers/wise';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'wise',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiToken: 'tok' }),
};

describe('WiseProvider', () => {
  test('declares balance + transactions + credential-validator capabilities', () => {
    const p = new WiseProvider(passthroughLimiter());
    expect(p.capabilities).toContain('current-balances');
    expect(p.capabilities).toContain('transactions');
    expect(p.capabilities).toContain('credential-validator');
  });

  test('canFetchBalances gates on wise', () => {
    const p = new WiseProvider(passthroughLimiter());
    expect(p.canFetchBalances('wise')).toBe(true);
    expect(p.canFetchBalances('ibkr')).toBe(false);
  });

  test('canFetchTransactions gates on wise', () => {
    const p = new WiseProvider(passthroughLimiter());
    expect(p.canFetchTransactions('wise')).toBe(true);
    expect(p.canFetchTransactions('ibkr')).toBe(false);
  });

  test('fetchBalances merges per-profile multi-currency balances, drops zeros', async () => {
    const p = new WiseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/v2/profiles')) {
        return new Response(
          JSON.stringify([
            { id: 1, type: 'PERSONAL', fullName: 'Alice' },
            { id: 2, type: 'BUSINESS', fullName: 'Acme' },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/v4/profiles/1/balances')) {
        return new Response(
          JSON.stringify([
            { id: 11, currency: 'USD', amount: { value: 100, currency: 'USD' }, type: 'STANDARD' },
            { id: 12, currency: 'EUR', amount: { value: 0, currency: 'EUR' }, type: 'STANDARD' },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/v4/profiles/2/balances')) {
        return new Response(
          JSON.stringify([
            { id: 21, currency: 'USD', amount: { value: 50, currency: 'USD' }, type: 'STANDARD' },
            { id: 22, currency: 'GBP', amount: { value: 25, currency: 'GBP' }, type: 'STANDARD' },
          ]),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      const usd = out.find((h) => h.tokenIdentity.symbol === 'USD');
      const gbp = out.find((h) => h.tokenIdentity.symbol === 'GBP');
      expect(usd?.balance).toBe('150');
      expect(gbp?.balance).toBe('25');
      expect(out.find((h) => h.tokenIdentity.symbol === 'EUR')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new WiseProvider(passthroughLimiter());
    const r = await p.validateCredentials({ apiToken: 'tok' }, 'ibkr');
    expect(r.valid).toBe(false);
  });

  test('validateCredentials rejects missing token', async () => {
    const p = new WiseProvider(passthroughLimiter());
    const r = await p.validateCredentials({}, 'wise');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('apiToken');
  });

  test('validateCredentials returns true when at least one profile is returned', async () => {
    const p = new WiseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: 1, type: 'PERSONAL', fullName: 'a' }]), {
        status: 200,
      })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiToken: 'tok' }, 'wise');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials returns false when zero profiles', async () => {
    const p = new WiseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiToken: 'tok' }, 'wise');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('zero profiles');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials surfaces HTTP 401 message', async () => {
    const p = new WiseProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;
    try {
      const r = await p.validateCredentials({ apiToken: 'tok' }, 'wise');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('WiseProvider.fetchTransactions', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Single-profile fixture with two balances (USD, EUR) and a CONVERSION
   * pair that crosses both — DEBIT side lives in the EUR statement,
   * CREDIT side in the USD statement, joined by a shared
   * `referenceNumber`. Also exercises a sibling fee row triggered by
   * `totalFees.value > 0` on the EUR transfer.
   */
  beforeEach(() => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/v2/profiles')) {
        return new Response(JSON.stringify([{ id: 1, type: 'PERSONAL', fullName: 'Alice' }]), {
          status: 200,
        });
      }
      if (url.includes('/v4/profiles/1/balances')) {
        return new Response(
          JSON.stringify([
            {
              id: 10,
              currency: 'USD',
              amount: { value: 1500, currency: 'USD' },
              type: 'STANDARD',
            },
            {
              id: 20,
              currency: 'EUR',
              amount: { value: 800, currency: 'EUR' },
              type: 'STANDARD',
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/balance-statements/10/statement.json')) {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                type: 'CREDIT',
                date: '2025-01-10T12:00:00.000Z',
                amount: { value: 1000, currency: 'USD' },
                totalFees: { value: 0, currency: 'USD' },
                details: { type: 'DEPOSIT', description: 'Bank deposit' },
                referenceNumber: 'DEP-1',
              },
              {
                type: 'CREDIT',
                date: '2025-01-15T08:00:00.000Z',
                amount: { value: 500, currency: 'USD' },
                totalFees: { value: 0, currency: 'USD' },
                details: { type: 'CONVERSION' },
                referenceNumber: 'CONV-1',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/balance-statements/20/statement.json')) {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                type: 'DEBIT',
                date: '2025-01-12T09:00:00.000Z',
                amount: { value: 200, currency: 'EUR' },
                totalFees: { value: 2, currency: 'EUR' },
                details: { type: 'TRANSFER' },
                referenceNumber: 'TRANS-1',
              },
              {
                type: 'DEBIT',
                date: '2025-01-20T16:30:00.000Z',
                amount: { value: 35, currency: 'EUR' },
                totalFees: { value: 0, currency: 'EUR' },
                details: { type: 'CARD' },
                referenceNumber: 'CARD-7',
              },
              {
                type: 'DEBIT',
                date: '2025-01-15T08:00:00.000Z',
                amount: { value: 450, currency: 'EUR' },
                totalFees: { value: 0, currency: 'EUR' },
                details: { type: 'CONVERSION' },
                referenceNumber: 'CONV-1',
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
  });

  test('maps CREDIT/DEBIT/CONVERSION rows and emits sibling fee events', async () => {
    const p = new WiseProvider(passthroughLimiter());
    const events = await p.fetchTransactions({
      ...ctx,
      since: new Date('2025-01-01T00:00:00.000Z'),
      until: new Date('2025-02-01T00:00:00.000Z'),
    } as never);
    const byId = new Map(events.map((e) => [e.externalId, e]));

    expect(byId.size).toBe(events.length);
    expect(events).toHaveLength(6);

    const deposit = byId.get('DEP-1-0');
    expect(deposit?.kind).toBe('deposit');
    expect(deposit?.primary.quantity).toBe('1000');
    expect(deposit?.primary.tokenIdentity.symbol).toBe('USD');

    const swapIn = byId.get('CONV-1-1');
    expect(swapIn?.kind).toBe('swap_in');
    expect(swapIn?.primary.quantity).toBe('500');
    expect(swapIn?.primary.tokenIdentity.symbol).toBe('USD');

    const withdraw = byId.get('TRANS-1-0');
    expect(withdraw?.kind).toBe('withdraw');
    expect(withdraw?.primary.quantity).toBe('-200');
    expect(withdraw?.primary.tokenIdentity.symbol).toBe('EUR');

    const swapOut = byId.get('CONV-1-2');
    expect(swapOut?.kind).toBe('swap_out');
    expect(swapOut?.primary.quantity).toBe('-450');
    expect(swapOut?.primary.tokenIdentity.symbol).toBe('EUR');

    const cardFee = byId.get('CARD-7-1');
    expect(cardFee?.kind).toBe('fee');
    expect(cardFee?.primary.quantity).toBe('-35');
    expect(cardFee?.primary.tokenIdentity.symbol).toBe('EUR');

    const fee = byId.get('TRANS-1-fee');
    expect(fee?.kind).toBe('fee');
    expect(fee?.primary.quantity).toBe('-2');
    expect(fee?.primary.tokenIdentity.symbol).toBe('EUR');
  });

  test('passes intervalStart/intervalEnd in ISO 8601 form on the statement URL', async () => {
    const captured: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      captured.push(url);
      return inner(url);
    }) as typeof fetch;

    const p = new WiseProvider(passthroughLimiter());
    await p.fetchTransactions({
      ...ctx,
      since: new Date('2025-01-01T00:00:00.000Z'),
      until: new Date('2025-02-01T00:00:00.000Z'),
    } as never);

    const stmt = captured.find((u) => u.includes('/balance-statements/10/statement.json'));
    expect(stmt).toBeDefined();
    expect(stmt).toContain('intervalStart=2025-01-01T00%3A00%3A00.000Z');
    expect(stmt).toContain('intervalEnd=2025-02-01T00%3A00%3A00.000Z');
    expect(stmt).toContain('type=COMPACT');
    expect(stmt).toContain('currency=USD');
  });
});

describe('WiseProvider.fetchTransactions window splitting', () => {
  test('splits >469-day windows into multiple statement requests per balance', async () => {
    const originalFetch = globalThis.fetch;
    const statementCalls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/v2/profiles')) {
        return new Response(JSON.stringify([{ id: 1, type: 'PERSONAL', fullName: 'Alice' }]), {
          status: 200,
        });
      }
      if (url.includes('/v4/profiles/1/balances')) {
        return new Response(
          JSON.stringify([
            {
              id: 10,
              currency: 'USD',
              amount: { value: 0, currency: 'USD' },
              type: 'STANDARD',
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/balance-statements/10/statement.json')) {
        statementCalls.push(url);
        return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    try {
      const p = new WiseProvider(passthroughLimiter());
      // 1000 days >> 469 → expect 3 chunks (469 + 469 + 62).
      await p.fetchTransactions({
        ...ctx,
        since: new Date('2023-01-01T00:00:00.000Z'),
        until: new Date('2025-09-27T00:00:00.000Z'),
      } as never);
      expect(statementCalls).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const LIVE = process.env.SCANI_LIVE === '1';
const live = LIVE ? describe : describe.skip;

live('WiseProvider live (sandbox)', () => {
  test('fetchBalances + fetchTransactions against Wise sandbox', async () => {
    const apiToken = process.env.SCANI_TESTNET_WISE_API_KEY;
    const baseUrl =
      process.env.SCANI_TESTNET_WISE_BASE_URL ?? 'https://api.sandbox.transferwise.tech';
    if (!apiToken) {
      throw new Error('SCANI_LIVE=1 requires SCANI_TESTNET_WISE_API_KEY');
    }
    const p = new WiseProvider(passthroughLimiter(), baseUrl);
    const liveCtx = {
      institutionCode: 'wise',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'live', institutionId: 'live' },
      resolveCredentials: async () => ({ apiToken }),
    };
    const balances = await p.fetchBalances(liveCtx as never);
    expect(Array.isArray(balances)).toBe(true);
    const events = await p.fetchTransactions(liveCtx as never);
    expect(Array.isArray(events)).toBe(true);
  });
});
