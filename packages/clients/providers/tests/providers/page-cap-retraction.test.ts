import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import type { TransactionEvent, TransactionFetchContext } from '../../src/core/types';
import { BitstampProvider } from '../../src/providers/bitstamp';
import { CoinbaseProvider } from '../../src/providers/coinbase';
import { GeminiProvider } from '../../src/providers/gemini';
import { HuobiProvider } from '../../src/providers/huobi';
import { KucoinProvider } from '../../src/providers/kucoin';
import {
  declaredHorizon,
  pageCapLoops,
  providerSources,
  truncationChannel,
} from '../helpers/provider-sources';

/**
 * A page cap that stops a walk without saying so writes
 * `holding_coverage.has_complete_tx_history = true` over a ledger that ended
 * early, and SC-149 renders that as a `complete` cost basis (SC-426).
 *
 * Every provider here is tested in BOTH directions, because the defect was
 * never a missing call — it was a call that could not distinguish a feed which
 * ran out from a walk which ran out of allowance. A test that only drove the
 * cap would pass on a provider that retracts unconditionally, which is the
 * SC-360 failure in the other direction: a window is silence about the ledger,
 * not evidence against it.
 */

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

function contextWithSink(institutionCode: string, creds: Record<string, string>) {
  const retractions: string[] = [];
  // The non-retracting half of the channel (SC-428). Collected separately
  // because the whole point of the split is that only one of the two moves
  // `has_complete_tx_history`, and a test that merged them could not tell.
  const notices: string[] = [];
  const ctx = {
    institutionCode,
    baseCurrency: { id: 'usd', symbol: 'USD' },
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => creds,
    retractHistoryClaim: (reason: string) => {
      retractions.push(reason);
    },
    noteWarning: (reason: string) => {
      notices.push(reason);
    },
  } as unknown as TransactionFetchContext;
  return { ctx, retractions, notices };
}

type Handler = (url: string) => unknown;

/** Install a fetch that answers from `routes`, first match wins. */
function withRoutes<T>(
  routes: ReadonlyArray<[RegExp, Handler]>,
  fallback: unknown,
  run: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) return new Response(JSON.stringify(handler(url)), { status: 200 });
    }
    return new Response(JSON.stringify(fallback), { status: 200 });
  }) as unknown as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** `n` rows the provider's mapper will decline, so the walk costs no memory. */
function unmappableRows(n: number, row: (i: number) => unknown): unknown[] {
  return Array.from({ length: n }, (_, i) => row(i));
}

// ============================================================
// Coinbase — two caps, and they are different failures
// ============================================================

const coinbaseAccount = (id: string) => ({
  id,
  name: 'BTC Wallet',
  type: 'wallet',
  currency: { code: 'BTC', name: 'Bitcoin' },
  balance: { amount: '1', currency: 'BTC' },
});

const coinbaseTx = {
  id: 'tx-1',
  type: 'unsupported',
  status: 'completed',
  created_at: '2026-01-01T00:00:00Z',
};

async function coinbaseRun(
  accountsEndless: boolean,
  transactionsEndless: boolean
): Promise<{ events: TransactionEvent[]; retractions: string[] }> {
  const provider = new CoinbaseProvider(passthroughLimiter());
  const { ctx, retractions } = contextWithSink('coinbase', { apiKey: 'k', apiSecret: 's' });
  let accountPage = 0;
  const events = await withRoutes(
    [
      [
        /\/v2\/accounts\/[^/]+\/transactions/,
        () => ({
          data: [coinbaseTx],
          pagination: transactionsEndless
            ? { next_uri: '/v2/accounts/acct-0/transactions?p=1' }
            : {},
        }),
      ],
      [
        /\/v2\/accounts/,
        () => {
          accountPage += 1;
          return {
            data: [coinbaseAccount(accountsEndless ? `acct-${accountPage}` : 'acct-0')],
            pagination: accountsEndless ? { next_uri: `/v2/accounts?p=${accountPage}` } : {},
          };
        },
      ],
    ],
    {},
    () => provider.fetchTransactions(ctx)
  );
  return { events, retractions };
}

describe('coinbase page caps', () => {
  test('a transactions walk that exhausts its cap retracts, naming the account', async () => {
    const { retractions } = await coinbaseRun(false, true);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('coinbase: transactions for account acct-0');
    expect(retractions[0]).toContain('200-page cap');
  }, 30000);

  test('an account list that exhausts its cap retracts too — whole ledgers are missing', async () => {
    const { retractions } = await coinbaseRun(true, false);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('coinbase: the account list stopped at its 50-page cap');
  }, 30000);

  test('a feed that ends on its own retracts nothing', async () => {
    const { retractions } = await coinbaseRun(false, false);
    expect(retractions).toEqual([]);
  }, 30000);
});

// ============================================================
// Bitstamp
// ============================================================

async function bitstampRun(
  endless: boolean,
  endlessAnnotations = false
): Promise<{ retractions: string[]; notices: string[] }> {
  const provider = new BitstampProvider(passthroughLimiter());
  const { ctx, retractions, notices } = contextWithSink('bitstamp', {
    apiKey: 'k',
    apiSecret: 's',
  });
  const fullPage = unmappableRows(1000, (i) => ({
    id: i,
    datetime: '2026-01-01 00:00:00',
    type: '9',
  }));
  // 1000 is `CRYPTO_TX_PAGE_SIZE`; a page short of it is how the annotation
  // walk learns the feed ended, so a full one is the only way to reach the cap.
  const fullAnnotationPage = {
    deposits: unmappableRows(1000, (i) => ({
      currency: 'BTC',
      datetime: '2026-01-01 00:00:00',
      amount: '1',
      txid: `hash-${i}`,
    })),
  };
  await withRoutes(
    [
      [/user_transactions/, () => (endless ? fullPage : fullPage.slice(0, 3))],
      [/crypto-transactions/, () => (endlessAnnotations ? fullAnnotationPage : {})],
    ],
    [],
    () => provider.fetchTransactions(ctx)
  );
  return { retractions, notices };
}

describe('bitstamp page cap', () => {
  test('a ledger walk that exhausts its cap retracts', async () => {
    const { retractions } = await bitstampRun(true);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('bitstamp: the user-transactions ledger');
    expect(retractions[0]).toContain('200-page cap after 200000 rows');
  }, 30000);

  test('a ledger that ends inside one page retracts nothing', async () => {
    const { retractions, notices } = await bitstampRun(false);
    expect(retractions).toEqual([]);
    expect(notices).toEqual([]);
  }, 30000);

  /**
   * The txid lookup is a SECOND walk with its own cap, over events the ledger
   * walk already produced. Exhausting it drops an annotation and no rows, so
   * SC-426 left it alone rather than retract — and then nothing told anyone it
   * had happened (SC-428). It warns now, and the completeness claim is
   * untouched: that separation is the assertion.
   */
  test('the annotation walk warns without retracting', async () => {
    const { retractions, notices } = await bitstampRun(false, true);
    expect(retractions).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('bitstamp: the crypto-transactions lookup');
    expect(notices[0]).toContain('200-page cap after 200000 rows');
    expect(notices[0]).toContain('no on-chain transaction id');
  }, 60000);
});

// ============================================================
// Gemini
// ============================================================

async function geminiRun(endless: boolean): Promise<string[]> {
  const provider = new GeminiProvider(passthroughLimiter());
  const { ctx, retractions } = contextWithSink('gemini', { apiKey: 'k', apiSecret: 's' });
  // The cursor must keep advancing into older trades or the walk stops on its
  // own — a stalled cursor is a different exit than an exhausted cap.
  let timestamp = 1_800_000_000_000;
  await withRoutes(
    [
      [/\/v1\/balances/, () => [{ currency: 'BTC', amount: '1', type: 'exchange' }]],
      [
        /\/v1\/mytrades/,
        () => {
          timestamp -= 1;
          return unmappableRows(endless ? 500 : 2, () => ({
            tid: 1,
            timestampms: timestamp,
            type: 'Unsupported',
          }));
        },
      ],
      [/\/v2\/transfers/, () => []],
    ],
    [],
    () => provider.fetchTransactions(ctx)
  );
  return retractions;
}

describe('gemini page cap', () => {
  test('a trade walk that exhausts its cap retracts, naming the symbol', async () => {
    const retractions = await geminiRun(true);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('gemini: btcusd trades stopped at its 200-page cap');
  }, 60000);

  test('a short trade feed retracts nothing', async () => {
    expect(await geminiRun(false)).toEqual([]);
  }, 30000);
});

// ============================================================
// Huobi
// ============================================================

async function huobiRun(endlessSymbol: string | null): Promise<string[]> {
  const provider = new HuobiProvider(passthroughLimiter());
  const { ctx, retractions } = contextWithSink('huobi', { apiKey: 'k', apiSecret: 's' });
  let matchId = 0;
  await withRoutes(
    [
      [
        /\/v1\/account\/accounts\/\d+\/balance/,
        () => ({
          status: 'ok',
          data: { list: [{ currency: 'btc', balance: '1', type: 'trade' }] },
        }),
      ],
      [
        /\/v1\/account\/accounts/,
        () => ({ status: 'ok', data: [{ id: 1, type: 'spot', state: 'working' }] }),
      ],
      [
        /\/v1\/order\/matchresults/,
        (url: string) => {
          const symbol = new URL(url).searchParams.get('symbol');
          const full = endlessSymbol !== null && symbol === endlessSymbol;
          return {
            status: 'ok',
            data: unmappableRows(full ? 500 : 1, () => ({
              id: ++matchId,
              symbol: 'zzzzz',
              type: 'buy-limit',
            })),
          };
        },
      ],
      [/\/v1\/query\/deposit-withdraw/, () => ({ status: 'ok', data: [] })],
    ],
    { status: 'error' },
    () => provider.fetchTransactions(ctx)
  );
  return retractions;
}

describe('huobi page cap', () => {
  test('the one symbol whose feed never ends is the one named', async () => {
    const retractions = await huobiRun('btcusdt');
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('huobi: btcusdt trades stopped at its 200-page cap');
    // Three other candidate symbols were walked and ended on their own; none
    // of them is in the warning.
    expect(retractions[0]).not.toContain('btcusdc');
  }, 60000);

  test('feeds that all end on their own retract nothing', async () => {
    expect(await huobiRun(null)).toEqual([]);
  }, 30000);
});

// ============================================================
// KuCoin
// ============================================================

async function kucoinRun(endless: boolean): Promise<string[]> {
  const provider = new KucoinProvider(passthroughLimiter());
  const { ctx, retractions } = contextWithSink('kucoin', {
    apiKey: 'k',
    apiSecret: 's',
    passphrase: 'p',
  });
  const paged = (items: unknown[], totalPage: number) => ({
    code: '200000',
    data: { currentPage: 1, pageSize: items.length, totalNum: 1, totalPage, items },
  });
  await withRoutes(
    [
      [
        /accounts\/ledgers/,
        () =>
          endless
            ? paged(
                unmappableRows(500, () => ({ amount: '0' })),
                99_999
              )
            : paged([], 1),
      ],
      [/hist-(deposits|withdrawals)/, () => paged([], 1)],
    ],
    { code: '200000', data: { items: [], totalPage: 1 } },
    () => provider.fetchTransactions(ctx)
  );
  return retractions;
}

describe('kucoin page cap', () => {
  test('a ledger feed longer than the cap retracts, naming the endpoint', async () => {
    const retractions = await kucoinRun(true);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain(
      'kucoin: the /api/v1/accounts/ledgers feed stopped at its 400-page cap after 200000 rows'
    );
  }, 60000);

  test('an empty ledger retracts nothing', async () => {
    expect(await kucoinRun(false)).toEqual([]);
  }, 30000);
});

// ============================================================
// The guard that travels
// ============================================================

/**
 * The population is derived, not listed: a provider that caps its pages AND
 * declares no horizon is one whose `since`-less run `TransactionRouter` will
 * mark complete, so it must have some way to say the walk came back short.
 *
 * Deriving it from the horizon rather than from a hand-written list is what
 * makes it self-adjusting. A provider that later drops its
 * `transactionHistoryHorizonMs` starts claiming completeness, and this test
 * starts demanding a retraction channel from it on the same commit.
 */
describe('every provider that can claim a complete history can also retract it', () => {
  const sources = providerSources();
  const canClaimAndCaps = sources.filter(
    (s) => pageCapLoops(s.source).length > 0 && declaredHorizon(s.source) === null
  );

  test('the scan finds the providers that cap pages while claiming completeness', () => {
    expect(canClaimAndCaps.map((s) => s.name).sort()).toEqual([
      'bitstamp',
      'coinbase',
      'gemini',
      'huobi',
      'kraken',
      'kucoin',
    ]);
  });

  // Kraken is in that list and is NOT a defect: it returns
  // `{ hasCompleteTxHistory: false }` from its paginator and `BaseCexProvider`
  // forwards it (SC-395). Both shapes count; having neither does not.
  test.each(canClaimAndCaps.map((s) => s.name))('%s declares a truncation channel', (name) => {
    const source = sources.find((s) => s.name === name)?.source ?? '';
    expect(truncationChannel(source)).not.toBeNull();
  });

  // A provider that declares a horizon cannot write a wrong `true` from a page
  // cap, because `claimsCompleteHistory` is already false for it. Asserting
  // that here keeps the exclusion honest rather than incidental.
  test('the providers left out are left out because they declare a horizon', () => {
    const cappedWithHorizon = sources
      .filter((s) => pageCapLoops(s.source).length > 0 && declaredHorizon(s.source) !== null)
      .map((s) => s.name)
      .sort();
    expect(cappedWithHorizon).toEqual(['airwallex', 'binance', 'bitget', 'gate', 'mexc', 'okx']);
  });
});

// Negative controls. Each reader must be able to come back empty, or the
// checks above pass on every file including one that says nothing at all.
describe('the source scan can fail', () => {
  test('pageCapLoops sees a bounded loop and ignores an unbounded one', () => {
    expect(pageCapLoops('for (let page = 0; page < MAX_TRADE_PAGES; page++) {')).toEqual([
      'MAX_TRADE_PAGES',
    ]);
    expect(pageCapLoops('while (currentPage <= MAX_PAGES) {')).toEqual(['MAX_PAGES']);
    expect(pageCapLoops('while (nextUri) {')).toEqual([]);
    // A cap on something that is not pages is not this defect.
    expect(pageCapLoops('if (out.length >= MAX_CANDIDATE_SYMBOLS) return out;')).toEqual([]);
  });

  test('truncationChannel sees both shapes and their absence', () => {
    expect(truncationChannel('return { hasCompleteTxHistory: false, reason };')).toBe('verdict');
    expect(truncationChannel('const capped = new PageCapWatch();')).toBe('page-cap-watch');
    expect(truncationChannel('while (pages < MAX_PAGES) { await next(); }')).toBeNull();
  });
});
