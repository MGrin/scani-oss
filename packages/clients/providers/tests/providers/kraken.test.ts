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
    // Shaped like a real production earn/spot pair — INCLUDING the asset
    // codes; the identifiers and quantities are synthetic. The two legs
    // are `XETH.F` and `XETH`, never one code twice: every such pair in
    // production carries two distinct raw codes, and a fixture that put
    // both on `XETH` is what let the suppression ship inert.
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            'LEARN1-AAAAA-000001': ledgerEntry({
              refid: 'REARN01-AAAAA-0000001',
              subtype: 'autoallocation',
              asset: 'XETH.F',
              amount: '0.2500000000',
            }),
            'LEARN2-BBBBB-000002': ledgerEntry({
              refid: 'REARN01-AAAAA-0000001',
              subtype: 'autoallocation',
              asset: 'XETH',
              amount: '-0.2500000000',
            }),
          },
          count: 2,
        },
      })
    );
    expect(await p.fetchTransactions(baseCtx as never)).toEqual([]);
  });

  test('the earn-to-spot direction cancels too, through the XXBT alias', async () => {
    // The opposite direction: the `.F` earn leg is negative. Some of
    // these pairs are BTC, whose codes reach one symbol via the suffix
    // strip, the 'X' strip AND the XBT alias.
    const p = new KrakenProvider(
      stubApi({
        ledgers: {
          ledger: {
            'LEARN3-CCCCC-000003': ledgerEntry({
              refid: 'REARN02-BBBBB-0000002',
              subtype: 'autoallocation',
              asset: 'XXBT',
              amount: '0.3500000000',
            }),
            'LEARN4-DDDDD-000004': ledgerEntry({
              refid: 'REARN02-BBBBB-0000002',
              subtype: 'autoallocation',
              asset: 'XXBT.F',
              amount: '-0.3500000000',
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
              amount: '0.2500000000',
            }),
            'LHHHHH-88888-HHHHHH': ledgerEntry({
              refid: 'CROSS-ASSET-0004',
              subtype: 'autoallocation',
              asset: 'XXBT',
              amount: '-0.2500000000',
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
              amount: '0.2500000000',
            }),
            'LDDDDD-44444-DDDDDD': ledgerEntry({
              refid: 'PLAIN-REFID-0002',
              type: 'withdrawal',
              subtype: undefined,
              asset: 'XETH',
              amount: '-0.2500000000',
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
              amount: '0.2500000000',
            }),
            'LFFFFF-66666-FFFFFF': ledgerEntry({
              refid: 'FEE-REFID-0003',
              subtype: 'autoallocation',
              asset: 'XETH',
              amount: '-0.2500000000',
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
    firstPage['LEARN1-AAAAA-000001'] = ledgerEntry({
      refid: 'REARN01-AAAAA-0000001',
      subtype: 'autoallocation',
      asset: 'XETH.F',
      amount: '0.2500000000',
    });

    const p = new KrakenProvider(
      stubApi({
        ledgerPages: [
          { ledger: firstPage, count: 51 },
          {
            ledger: {
              'LEARN2-BBBBB-000002': ledgerEntry({
                refid: 'REARN01-AAAAA-0000001',
                subtype: 'autoallocation',
                asset: 'XETH',
                amount: '-0.2500000000',
              }),
            },
            count: 51,
          },
        ],
      })
    );

    const events = await p.fetchTransactions(baseCtx as never);
    expect(events).toHaveLength(49);
    expect(events.some((e) => e.externalId.startsWith('LEARN1'))).toBe(false);
    expect(events.some((e) => e.externalId.startsWith('LEARN2'))).toBe(false);
  }, 15_000); // One real `PAGE_COOLDOWN_MS` sleep sits between the two pages.
});

// SC-1486: Kraken's own `amount` is the direction. Three production rows
// carried a NEGATIVE amount under a type the mapping always read as an
// inflow, and each was stored as money in.
describe('KrakenProvider — the amount decides the direction (SC-1486)', () => {
  const at = (iso: string) => new Date(iso).getTime() / 1000;
  const walk = (ledger: Record<string, KrakenLedgerEntry>) =>
    new KrakenProvider(
      stubApi({ ledgers: { ledger, count: Object.keys(ledger).length } })
    ).fetchTransactions(baseCtx as never);

  test('a returned deposit leaves, net of the fee it refunded', async () => {
    const events = await walk({
      'LDEP01-AAAAA-000001': ledgerEntry({
        refid: 'FTRET01',
        type: 'deposit',
        asset: 'EUR.HOLD',
        amount: '-300.0000',
        fee: '-12.0000',
        balance: '0.0000',
      }),
    });
    expect(events.map((e) => [e.kind, e.primary.quantity, e.fee])).toEqual([
      ['withdraw', '-288', undefined],
    ]);
  });

  test('a staking debit with a matching credit on another asset is one swap', async () => {
    const events = await walk({
      'LMIG01-AAAAA-000001': ledgerEntry({
        refid: 'STOUT01',
        type: 'staking',
        asset: 'ETH2',
        amount: '-0.0312345678',
        time: at('2020-03-11T10:00:00Z'),
      }),
      'LMIG02-BBBBB-000002': ledgerEntry({
        refid: 'STIN01',
        type: 'staking',
        asset: 'XETH',
        amount: '0.0312345678',
        time: at('2020-03-10T12:00:00Z'),
      }),
      'LREW01-CCCCC-000003': ledgerEntry({
        refid: 'STREW01',
        type: 'staking',
        asset: 'XETH',
        amount: '0.0001111111',
        time: at('2020-03-09T10:00:00Z'),
      }),
    });
    const byId = new Map(events.map((e) => [e.externalId, e]));
    const out = byId.get('LMIG01-AAAAA-000001');
    const into = byId.get('LMIG02-BBBBB-000002');
    expect([out?.kind, out?.primary.quantity, into?.kind, into?.primary.quantity]).toEqual([
      'swap_out',
      '-0.0312345678',
      'swap_in',
      '0.0312345678',
    ]);
    expect(out?.swapGroupKey).toBeDefined();
    expect(out?.swapGroupKey).toBe(into?.swapGroupKey);
    expect(byId.get('LREW01-CCCCC-000003')?.kind).toBe('reward');
  });

  test('a staking debit with no matching credit is money out, not a reward', async () => {
    const events = await walk({
      'LMIG03-AAAAA-000004': ledgerEntry({
        refid: 'STOUT02',
        type: 'staking',
        asset: 'ETH2',
        amount: '-0.0004444440',
        time: at('2020-03-12T10:00:00Z'),
      }),
      'LMIG04-BBBBB-000005': ledgerEntry({
        refid: 'STIN02',
        type: 'staking',
        asset: 'XETH',
        amount: '0.0004444440',
        // Outside the window: a coincidence of amounts, not a conversion.
        time: at('2020-04-12T10:00:00Z'),
      }),
    });
    const kinds = Object.fromEntries(
      events.map((e) => [e.externalId, [e.kind, e.primary.quantity]])
    );
    expect(kinds).toEqual({
      'LMIG03-AAAAA-000004': ['withdraw', '-0.000444444'],
      'LMIG04-BBBBB-000005': ['reward', '0.000444444'],
    });
  });

  test('control: an ordinary deposit and reward are unchanged', async () => {
    const events = await walk({
      'LDEP02-AAAAA-000006': ledgerEntry({
        refid: 'FTOK01',
        type: 'deposit',
        asset: 'ZEUR',
        amount: '340.0000',
        fee: '13.0000',
      }),
      'LREW02-BBBBB-000007': ledgerEntry({
        refid: 'STOK01',
        type: 'staking',
        asset: 'XETH',
        amount: '0.0007',
      }),
    });
    const kinds = Object.fromEntries(
      events.map((e) => [e.externalId, [e.kind, e.primary.quantity, e.fee?.quantity]])
    );
    expect(kinds).toEqual({
      'LDEP02-AAAAA-000006': ['deposit', '340', '-13'],
      'LREW02-BBBBB-000007': ['reward', '0.0007', undefined],
    });
  });
});

// SC-1486: moving a balance between spot and staking can change the asset
// Kraken books it under (ETH -> ETH2, SOL -> SOL03). The two legs are
// `transfer` entries on two different holdings, and unpaired each one read
// as money in or out.
describe('KrakenProvider — a transfer that changes asset is a swap (SC-1486)', () => {
  const at = (iso: string) => new Date(iso).getTime() / 1000;
  const walk = (ledger: Record<string, KrakenLedgerEntry>) =>
    new KrakenProvider(
      stubApi({ ledgers: { ledger, count: Object.keys(ledger).length } })
    ).fetchTransactions(baseCtx as never);

  test('spot to staking under another asset pairs into one swap', async () => {
    const events = await walk({
      'LSPOT1-AAAAA-000001': ledgerEntry({
        refid: 'FTOUT1',
        type: 'transfer',
        subtype: 'spottostaking',
        asset: 'XETH',
        amount: '-1.0000000000',
        time: at('2020-02-01T10:00:00Z'),
      }),
      'LSTAK1-BBBBB-000002': ledgerEntry({
        refid: 'FTIN1',
        type: 'transfer',
        subtype: 'stakingfromspot',
        asset: 'ETH2.S',
        amount: '1.0000000000',
        time: at('2020-02-01T10:01:30Z'),
      }),
    });
    const byId = new Map(events.map((e) => [e.externalId, e]));
    const out = byId.get('LSPOT1-AAAAA-000001');
    const into = byId.get('LSTAK1-BBBBB-000002');
    expect([out?.kind, into?.kind]).toEqual(['swap_out', 'swap_in']);
    expect(out?.swapGroupKey).toBeDefined();
    expect(out?.swapGroupKey).toBe(into?.swapGroupKey);
  });

  test('control: a same-asset spot/staking move is not a swap', async () => {
    const events = await walk({
      'LSPOT2-AAAAA-000003': ledgerEntry({
        refid: 'FTOUT2',
        type: 'transfer',
        subtype: 'spottostaking',
        asset: 'DOT',
        amount: '-25.5000000',
        time: at('2020-02-02T10:00:00Z'),
      }),
      'LSTAK2-BBBBB-000004': ledgerEntry({
        refid: 'FTIN2',
        type: 'transfer',
        subtype: 'stakingfromspot',
        asset: 'DOT.S',
        amount: '25.5000000',
        time: at('2020-02-02T10:00:10Z'),
      }),
    });
    expect(events.some((e) => e.kind === 'swap_out' || e.kind === 'swap_in')).toBe(false);
  });
});

// SC-1486: a spot/staking move that stays on one asset is two `transfer`
// entries in one holding that cancel. Emitted, each reached Review as money
// out and money in; mgrin answered 14 of them `left_control` in one bulk
// action, which booked every one as a sale. Like a net-zero reallocation
// (SC-362), the pair is not an event.
describe('KrakenProvider — a same-asset spot/staking move is not an event (SC-1486)', () => {
  const at = (iso: string) => new Date(iso).getTime() / 1000;
  const walk = (ledger: Record<string, KrakenLedgerEntry>) =>
    new KrakenProvider(
      stubApi({ ledgers: { ledger, count: Object.keys(ledger).length } })
    ).fetchTransactions(baseCtx as never);

  test('the two legs cancel and neither is emitted', async () => {
    const events = await walk({
      'LSPOT3-AAAAA-000005': ledgerEntry({
        refid: 'FTOUT3',
        type: 'transfer',
        subtype: 'spottostaking',
        asset: 'SOL',
        amount: '-5.2500000000',
        time: at('2020-02-03T10:00:00Z'),
      }),
      'LSTAK3-BBBBB-000006': ledgerEntry({
        refid: 'FTIN3',
        type: 'transfer',
        subtype: 'stakingfromspot',
        asset: 'SOL03.S',
        amount: '5.2500000000',
        time: at('2020-02-03T10:01:09Z'),
      }),
    });
    expect(events).toEqual([]);
  });

  test('two pairs at one instant both cancel', async () => {
    const leg = (id: string, asset: string, amount: string) =>
      ledgerEntry({
        refid: `R${id}`,
        type: 'transfer',
        asset,
        amount,
        time: at('2020-02-04T10:00:00Z'),
      });
    const events = await walk({
      'LA-1': leg('A1', 'SOL.S', '-6.5000000000'),
      'LA-2': leg('A2', 'SOL', '6.5000000000'),
      'LA-3': leg('A3', 'SOL', '-6.5000000000'),
      'LA-4': leg('A4', 'SOL.S', '6.5000000000'),
    });
    expect(events).toEqual([]);
  });

  test('controls: a real withdrawal, and transfers minutes apart, are kept', async () => {
    const events = await walk({
      'LWD-1': ledgerEntry({
        refid: 'RW1',
        type: 'withdrawal',
        asset: 'USDC',
        amount: '-1500.00',
        time: at('2020-02-05T10:00:00Z'),
      }),
      'LDP-1': ledgerEntry({
        refid: 'RD1',
        type: 'deposit',
        asset: 'USDC',
        amount: '1500.00',
        time: at('2020-02-05T10:01:00Z'),
      }),
      'LFAR-1': ledgerEntry({
        refid: 'RF1',
        type: 'transfer',
        asset: 'ADA',
        amount: '-100',
        time: at('2022-01-01T00:00:00Z'),
      }),
      'LFAR-2': ledgerEntry({
        refid: 'RF2',
        type: 'transfer',
        asset: 'ADA.S',
        amount: '100',
        time: at('2022-01-01T00:10:00Z'),
      }),
    });
    expect(events.map((e) => e.externalId).sort()).toEqual(['LDP-1', 'LFAR-1', 'LFAR-2', 'LWD-1']);
  });
});
