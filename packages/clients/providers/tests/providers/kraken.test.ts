import { describe, expect, test } from 'bun:test';
import { ProviderError } from '../../src/core/errors';
import { KrakenProvider } from '../../src/providers/kraken';
import type { KrakenApiService, KrakenLedgerEntry } from '../../src/providers/kraken/api-service';

type Ledgers = Awaited<ReturnType<KrakenApiService['fetchLedgers']>>;

interface StubOpts {
  balances?: Array<{ asset: string; balance: string }>;
  ledgers?: Ledgers;
  /** One entry per `ofs` page, walked in order. Overrides `ledgers`. */
  ledgerPages?: Ledgers[];
  validateThrows?: Error;
}

function stubApi(opts: StubOpts = {}): KrakenApiService {
  let pageIndex = 0;
  return {
    async getBalances() {
      return opts.balances ?? [];
    },
    async fetchLedgers() {
      if (opts.ledgerPages) {
        const page = opts.ledgerPages[pageIndex] ?? { ledger: {}, count: 0 };
        pageIndex += 1;
        return page;
      }
      return opts.ledgers ?? { ledger: {}, count: 0 };
    },
    async validateApiKey() {
      if (opts.validateThrows) throw opts.validateThrows;
      return true;
    },
  } as unknown as KrakenApiService;
}

/** Unix seconds for 2025-02-23T03:59:48.498Z — the production pair's instant. */
const PAIR_TIME = 1740283188.498;

function ledgerEntry(
  over: Partial<KrakenLedgerEntry> & Pick<KrakenLedgerEntry, 'refid' | 'amount'>
): KrakenLedgerEntry {
  return {
    time: PAIR_TIME,
    type: 'transfer',
    aclass: 'currency',
    asset: 'XETH',
    fee: '0.0000000000',
    balance: '1.0000000000',
    ...over,
  };
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
    const p = new KrakenProvider(
      stubApi({
        validateThrows: new ProviderError(
          'Kraken rejected request: EAPI:Invalid signature',
          'auth-failed',
          'kraken'
        ),
      })
    );
    const r = await p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'kraken');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('Invalid signature');
  });

  /**
   * Kraken being down is not a verdict on the key (SC-445). Answering
   * `valid: false` here is what sent people to regenerate credentials that
   * were never wrong, so the throw has to survive the validator.
   */
  test('validateCredentials rethrows a transient failure instead of failing the key', async () => {
    const p = new KrakenProvider(
      stubApi({
        validateThrows: new ProviderError(
          'Kraken rejected request: EService:Unavailable',
          'retryable',
          'kraken'
        ),
      })
    );
    expect(p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'kraken')).rejects.toThrow(
      'EService:Unavailable'
    );
  });

  test('validateCredentials rethrows a rate limit instead of failing the key', async () => {
    const p = new KrakenProvider(
      stubApi({
        validateThrows: new ProviderError(
          'Kraken rejected request: EAPI:Rate limit exceeded',
          'rate-limited',
          'kraken'
        ),
      })
    );
    expect(p.validateCredentials({ apiKey: 'k', apiSecret: 's' }, 'kraken')).rejects.toThrow(
      'Rate limit'
    );
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

// SC-362. Kraken states one automatic earn reallocation as two ledger
// entries under one `refid`, equal and opposite at the identical
// instant. It changes nothing about the position, so nothing reaches
// the ledger — and the guard is the refid's arithmetic, not the
// subtype alone, so an operation that does move something survives it.
describe('KrakenProvider — autoallocation', () => {
  test('a refid whose autoallocation entries cancel reaches the ledger as nothing', async () => {
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            ***REMOVED***
              ***REMOVED***
              subtype: 'autoallocation',
              asset: 'XETH.F',
              amount: '0.1433234990',
            }),
            ***REMOVED***
              ***REMOVED***
              subtype: 'autoallocation',
              asset: 'XETH',
              amount: '-0.1433234990',
            }),
          },
          count: 2,
        },
      })
    );
    expect(await p.fetchTransactions(baseCtx as never)).toEqual([]);
  });

  test('the earn-to-spot direction cancels too, through the XXBT alias', async () => {
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            ***REMOVED***
              refid: 'ELWRKNK-P4VIK-2C7HOA',
              subtype: 'autoallocation',
              asset: 'XXBT',
              amount: '0.1015321700',
            }),
            ***REMOVED***
              refid: 'ELWRKNK-P4VIK-2C7HOA',
              subtype: 'autoallocation',
              asset: 'XXBT.F',
              amount: '-0.1015321700',
            }),
          },
          count: 2,
        },
      })
    );
    expect(await p.fetchTransactions(baseCtx as never)).toEqual([]);
  });

  test('two genuinely different assets under one refid never net against each other', async () => {
    // The per-asset bucketing is the part that was right: equal and
    // opposite quantities of ETH and BTC cancel arithmetically and
    // mean nothing. Normalizing the code must not collapse that.
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            'LGGGGG-77777-GGGGGG': ledgerEntry({
              refid: 'CROSS-ASSET-0004',
              subtype: 'autoallocation',
              asset: 'XETH.F',
              amount: '0.1433234990',
            }),
            'LHHHHH-88888-HHHHHH': ledgerEntry({
              refid: 'CROSS-ASSET-0004',
              subtype: 'autoallocation',
              asset: 'XXBT',
              amount: '-0.1433234990',
            }),
          },
          count: 2,
        },
      })
    );
    const events = await p.fetchTransactions(baseCtx as never);
    expect(events.map((e) => e.externalId).sort()).toEqual([
      'LGGGGG-77777-GGGGGG',
      'LHHHHH-88888-HHHHHH',
    ]);
    expect(events.map((e) => e.primary.tokenIdentity.symbol).sort()).toEqual(['BTC', 'ETH']);
  });

  test('a refid whose autoallocation entries do NOT cancel is untouched', async () => {
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            'LAAAAA-11111-AAAAAA': ledgerEntry({
              refid: 'PARTIAL-REFID-0001',
              subtype: 'autoallocation',
              asset: 'XETH.F',
              amount: '0.5000000000',
            }),
            'LBBBBB-22222-BBBBBB': ledgerEntry({
              refid: 'PARTIAL-REFID-0001',
              subtype: 'autoallocation',
              asset: 'XETH',
              amount: '-0.2000000000',
            }),
          },
          count: 2,
        },
      })
    );
    const events = await p.fetchTransactions(baseCtx as never);
    expect(events.map((e) => e.externalId).sort()).toEqual([
      'LAAAAA-11111-AAAAAA',
      'LBBBBB-22222-BBBBBB',
    ]);
    expect(events.map((e) => e.primary.quantity).sort()).toEqual(['-0.2', '0.5']);
  });

  test('a cancelling pair without the autoallocation subtype is untouched', async () => {
    // The rule is not "same refid, opposite amounts" — the subtype is
    // what says Kraken moved the asset within one account, and it is
    // also what keeps the buffer bounded to a handful of entries.
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            'LCCCCC-33333-CCCCCC': ledgerEntry({
              refid: 'PLAIN-REFID-0002',
              type: 'deposit',
              subtype: undefined,
              asset: 'XETH.F',
              amount: '0.1433234990',
            }),
            'LDDDDD-44444-DDDDDD': ledgerEntry({
              refid: 'PLAIN-REFID-0002',
              type: 'withdrawal',
              subtype: undefined,
              asset: 'XETH',
              amount: '-0.1433234990',
            }),
          },
          count: 2,
        },
      })
    );
    const events = await p.fetchTransactions(baseCtx as never);
    expect(events.map((e) => e.externalId).sort()).toEqual([
      'LCCCCC-33333-CCCCCC',
      'LDDDDD-44444-DDDDDD',
    ]);
  });

  test('a cancelling pair that charged a fee is untouched — a fee is a real disposal', async () => {
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            'LEEEEE-55555-EEEEEE': ledgerEntry({
              refid: 'FEE-REFID-0003',
              subtype: 'autoallocation',
              asset: 'XETH.F',
              amount: '0.1433234990',
            }),
            'LFFFFF-66666-FFFFFF': ledgerEntry({
              refid: 'FEE-REFID-0003',
              subtype: 'autoallocation',
              asset: 'XETH',
              amount: '-0.1433234990',
              fee: '0.0000100000',
            }),
          },
          count: 2,
        },
      })
    );
    const events = await p.fetchTransactions(baseCtx as never);
    expect(events.map((e) => e.externalId).sort()).toEqual([
      'LEEEEE-55555-EEEEEE',
      'LFFFFF-66666-FFFFFF',
    ]);
    const charged = events.find((e) => e.externalId === 'LFFFFF-66666-FFFFFF');
    expect(charged?.fee?.quantity).toBe('-0.00001');
  });

  test('a pair split across the `ofs` page boundary still cancels', async () => {
    // The two entries share a timestamp but not necessarily a page, so
    // the suppression cannot be decided per page. First page is full
    // (50 rows) or pagination stops; its last row is one leg, and the
    // other leg opens the next page.
    const firstPage: Record<string, KrakenLedgerEntry> = {};
    for (let i = 0; i < 49; i++) {
      firstPage[`LFILL${i}-00000-FILLER`] = ledgerEntry({
        refid: `FILL-${i}`,
        type: 'deposit',
        amount: '1.0000000000',
      });
    }
    ***REMOVED***
      ***REMOVED***
      subtype: 'autoallocation',
      asset: 'XETH.F',
      amount: '0.1433234990',
    });

    const p = new KrakenProvider(
      stubApi({
        ledgerPages: [
          { ledger: firstPage, count: 51 },
          {
            ledger: {
              ***REMOVED***
                ***REMOVED***
                subtype: 'autoallocation',
                asset: 'XETH',
                amount: '-0.1433234990',
              }),
            },
            count: 51,
          },
        ],
      })
    );

    const events = await p.fetchTransactions(baseCtx as never);
    expect(events).toHaveLength(49);
    ***REMOVED***
    ***REMOVED***
  }, 15_000); // One real `PAGE_COOLDOWN_MS` sleep sits between the two pages.
});
