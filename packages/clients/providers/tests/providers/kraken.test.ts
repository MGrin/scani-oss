import { describe, expect, test } from 'bun:test';
import { KrakenProvider } from '../../src/providers/kraken';
import type { KrakenApiService } from '../../src/providers/kraken/api-service';

interface StubOpts {
  balances?: Array<{ asset: string; balance: string }>;
  ledgers?: Awaited<ReturnType<KrakenApiService['fetchLedgers']>>;
  validateThrows?: Error;
}

function stubApi(opts: StubOpts = {}): KrakenApiService {
  return {
    async getBalances() {
      return opts.balances ?? [];
    },
    async fetchLedgers() {
      return opts.ledgers ?? { ledger: {}, count: 0 };
    },
    async validateApiKey() {
      if (opts.validateThrows) throw opts.validateThrows;
      return true;
    },
  } as unknown as KrakenApiService;
}

const baseCtx = {
  institutionCode: 'kraken',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
};

describe('KrakenProvider', () => {
  test('canFetchBalances / canFetchTransactions gate on kraken', () => {
    const p = new KrakenProvider(stubApi());
    expect(p.canFetchBalances('kraken')).toBe(true);
    expect(p.canFetchBalances('binance')).toBe(false);
    expect(p.canFetchTransactions('kraken')).toBe(true);
  });

  test('fetchBalances skips zero-string balances and emits non-zero ones', async () => {
    const p = new KrakenProvider(
      stubApi({
        balances: [
          { asset: 'XXBT', balance: '0.5' },
          { asset: 'ZUSD', balance: '0' },
          { asset: 'XETH', balance: '0.00000000' },
          { asset: 'ADA', balance: '100' },
        ],
      })
    );
    const out = await p.fetchBalances(baseCtx as never);
    const symbols = out.map((h) => h.tokenIdentity.symbol).sort();
    // normalizeKrakenAsset maps XXBT → BTC, ADA → ADA
    expect(symbols.length).toBe(2);
    const btc = out.find((h) => h.tokenIdentity.symbol === 'BTC');
    expect(btc?.balance).toBe('0.5');
    const meta = btc?.tokenIdentity.providerMetadata as { kraken: { asset: string } };
    expect(meta.kraken.asset).toBe('XXBT');
  });

  test('canPrice rejects tokens without a kraken metadata namespace', () => {
    const p = new KrakenProvider(stubApi());
    expect(
      p.canPrice({
        id: 't',
        symbol: 'BTC',
        name: 'Bitcoin',
        typeId: 'tt',
        decimals: 8,
        marketSegment: null,
        iconUrl: null,
        providerMetadata: {},
        isScamProbability: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never)
    ).toBe(false);
  });

  test('fetchCurrentPrice always returns null (deferred to dedicated providers)', async () => {
    const p = new KrakenProvider(stubApi());
    const out = await p.fetchCurrentPrice({} as never, {} as never);
    expect(out).toBeNull();
  });

  test('validateCredentials happy path', async () => {
    const p = new KrakenProvider(stubApi());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'kraken');
    expect(r.valid).toBe(true);
  });

  test('validateCredentials surfaces upstream error message', async () => {
    const p = new KrakenProvider(stubApi({ validateThrows: new Error('EAPI:Invalid signature') }));
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'kraken');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('Invalid signature');
  });

  test('validateCredentials rejects wrong institution code', async () => {
    const p = new KrakenProvider(stubApi());
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'binance');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('Wrong institution');
  });

  test('validateCredentials rejects missing creds', async () => {
    const p = new KrakenProvider(stubApi());
    const r = await p.validateCredentials({}, 'kraken');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('apiKey');
  });
});
