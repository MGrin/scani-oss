import { describe, expect, test } from 'bun:test';
import type {
  KrakenApiService,
  KrakenLedgerEntry,
} from '../../../src/providers/kraken/api-service';
import { KrakenProvider } from '../../../src/providers/kraken/index';
import {
  auditKrakenLedger,
  type KrakenLedgerRow,
} from '../../../src/providers/kraken/ledger-integrity';

/** 2024-10-18T08:06:08Z — the production `spend XXBT` with no `receive`. */
const SPEND_TIME = 1729238768;

function row(
  ledgerId: string,
  over: Partial<KrakenLedgerEntry> & Pick<KrakenLedgerEntry, 'refid' | 'amount' | 'balance'>
): KrakenLedgerRow {
  return {
    ledgerId,
    entry: {
      time: SPEND_TIME,
      type: 'deposit',
      aclass: 'currency',
      asset: 'XETH',
      fee: '0.0000000000',
      subtype: '',
      ...over,
    },
  };
}

describe('auditKrakenLedger — balance chains', () => {
  test('a chain that adds up audits clean', () => {
    const audit = auditKrakenLedger([
      row('L1', { refid: 'FT1', amount: '1.0000000000', balance: '1.0000000000', time: 100 }),
      row('L2', { refid: 'FT2', amount: '0.5000000000', balance: '1.5000000000', time: 200 }),
      row('L3', { refid: 'FT3', amount: '-0.2500000000', balance: '1.2500000000', time: 300 }),
    ]);
    expect(audit.isComplete).toBe(true);
    expect(audit.balanceChainBreaks).toEqual([]);
  });

  test('the fee is subtracted, not ignored', () => {
    // Production 2022-04-13: `receive ZUSD` of 908.64 with a 13.43 fee
    // moved the balance from 0.0044 to 895.2144. Ignoring the fee would
    // read that as a 13.43 break.
    const audit = auditKrakenLedger([
      row('L1', { refid: 'A', asset: 'ZUSD', amount: '0.0044', balance: '0.0044', time: 100 }),
      row('L2', {
        refid: 'B',
        asset: 'ZUSD',
        type: 'receive',
        amount: '908.6400',
        fee: '13.4300',
        balance: '895.2144',
        time: 200,
      }),
    ]);
    expect(audit.balanceChainBreaks).toEqual([]);
  });

  test('a break names the asset, the instant and the size of what is missing', () => {
    // Production 2026-06-01 07:56:57: the chain stood at 56.99715, the
    // entry adds 1.86530 net of a 0.55959 fee — and Kraken reported
    // 60.89355, which is 2.59069 more than that accounts for.
    const audit = auditKrakenLedger([
      row('L1', { refid: 'A', asset: 'BABY', amount: '1.00000', balance: '56.99715', time: 100 }),
      row('L2', {
        refid: 'B',
        asset: 'BABY',
        type: 'staking',
        amount: '1.86530',
        fee: '0.55959',
        balance: '60.89355',
        time: 200,
      }),
    ]);
    expect(audit.isComplete).toBe(false);
    expect(audit.balanceChainBreaks).toHaveLength(1);
    const [gap] = audit.balanceChainBreaks;
    expect(gap?.asset).toBe('BABY');
    expect(gap?.ledgerId).toBe('L2');
    expect(gap?.missing).toBe('2.59069');
    expect(gap?.at).toEqual(new Date(200_000));
  });

  test('the first entry of an asset seeds the chain instead of being checked against zero', () => {
    // An incremental sync names a `start`, so its oldest entry opens on
    // a balance the walk never watched accumulate.
    const audit = auditKrakenLedger([
      row('L1', { refid: 'A', amount: '0.5000000000', balance: '9.5000000000', time: 100 }),
      row('L2', { refid: 'B', amount: '0.5000000000', balance: '10.0000000000', time: 200 }),
    ]);
    expect(audit.isComplete).toBe(true);
  });

  test('`XETH` and `XETH.F` are separate balances, not one ETH chain', () => {
    // Normalizing first would net a spot entry against an earn entry and
    ***REMOVED***
    const audit = auditKrakenLedger([
      row('L1', {
        refid: 'A',
        asset: 'XETH',
        amount: '-0.1433234990',
        balance: '1.0000000000',
        time: 100,
      }),
      row('L2', {
        refid: 'A',
        asset: 'XETH.F',
        amount: '0.1433234990',
        balance: '5.0000000000',
        time: 100,
      }),
      row('L3', {
        refid: 'B',
        asset: 'XETH',
        amount: '-1.0000000000',
        balance: '0.0000000000',
        time: 200,
      }),
      row('L4', {
        refid: 'B',
        asset: 'XETH.F',
        amount: '1.0000000000',
        balance: '6.0000000000',
        time: 200,
      }),
    ]);
    expect(audit.balanceChainBreaks).toEqual([]);
  });
});

describe('auditKrakenLedger — two-legged operations', () => {
  const paired: KrakenLedgerRow[] = [
    row('L1', {
      refid: 'TSK77T5-WIB3P-UHEIPJ',
      type: 'spend',
      asset: 'XETH',
      amount: '-0.2973100000',
      balance: '0.1957000000',
      time: 100,
    }),
    row('L2', {
      refid: 'TSK77T5-WIB3P-UHEIPJ',
      type: 'receive',
      asset: 'ZUSD',
      amount: '908.6400',
      fee: '13.4300',
      balance: '895.2144',
      time: 100,
    }),
  ];

  test('a convert with both legs audits clean', () => {
    expect(auditKrakenLedger(paired).isComplete).toBe(true);
  });

  test('a `spend` whose `receive` never arrived is reported', () => {
    ***REMOVED***
    ***REMOVED***
    // on either side of it.
    const audit = auditKrakenLedger([
      row('L1', {
        refid: 'TS6JBSQ-MTBTI-4B3RF7',
        type: 'spend',
        asset: 'XXBT',
        amount: '-0.0539012900',
        balance: '0.0000000000',
      }),
    ]);
    expect(audit.isComplete).toBe(false);
    expect(audit.unpairedOperations).toHaveLength(1);
    expect(audit.unpairedOperations[0]).toMatchObject({
      refid: 'TS6JBSQ-MTBTI-4B3RF7',
      type: 'spend',
      asset: 'XXBT',
      amount: '-0.0539012900',
    });
  });

  test('a `receive` whose `spend` never arrived is reported', () => {
    const audit = auditKrakenLedger([
      row('L1', {
        refid: 'TSXXXXX-XXXXX-XXXXXX',
        type: 'receive',
        asset: 'XETH',
        amount: '0.0263902500',
        balance: '0.0263902500',
      }),
    ]);
    expect(audit.unpairedOperations).toHaveLength(1);
    expect(audit.unpairedOperations[0]?.type).toBe('receive');
  });

  test('a spot trade with one leg is reported — its quote asset is invisible', () => {
    // Production T2N4XY-L2QPM-UY7N6R credited 0.15977714 XETH with no
    // quote leg, at a moment ZUSD stood at 0.0044.
    const audit = auditKrakenLedger([
      row('L1', {
        refid: 'T2N4XY-L2QPM-UY7N6R',
        type: 'trade',
        asset: 'XETH',
        amount: '0.1597771400',
        balance: '1.6463123961',
      }),
    ]);
    expect(audit.unpairedOperations).toHaveLength(1);
    expect(audit.unpairedOperations[0]?.type).toBe('trade');
  });

  test('a trade with both legs audits clean', () => {
    const audit = auditKrakenLedger([
      row('L1', {
        refid: 'TT1',
        type: 'trade',
        asset: 'XETH',
        amount: '0.1597771400',
        balance: '0.1597771400',
      }),
      row('L2', {
        refid: 'TT1',
        type: 'trade',
        asset: 'ZUSD',
        amount: '-501.8400',
        balance: '0.0044',
      }),
    ]);
    expect(audit.isComplete).toBe(true);
  });

  test('single-legged types are not gaps', () => {
    // `staking`, `deposit`, `withdrawal` are single-legged by nature,
    // and so is a `spottostaking` transfer — Kraken books its counter
    // side as a funding operation with its own refid, and the 144 XETH
    // rewards that ran through the 2022-08-18 → 2024-05-18 position
    // prove nothing went missing.
    const audit = auditKrakenLedger([
      row('L1', { refid: 'S1', type: 'staking', amount: '0.0001', balance: '1.0001', time: 100 }),
      row('L2', { refid: 'D1', type: 'deposit', amount: '1.0000', balance: '2.0001', time: 200 }),
      row('L3', {
        refid: 'W1',
        type: 'withdrawal',
        amount: '-1.0000',
        balance: '1.0001',
        time: 300,
      }),
      row('L4', {
        refid: 'FTWSLv3-cMCGvmAuDyx1Nv068cUnkm',
        type: 'transfer',
        subtype: 'spottostaking',
        amount: '-1.0000',
        balance: '0.0001',
        time: 400,
      }),
    ]);
    expect(audit.isComplete).toBe(true);
  });

  test('unpaired operations come back oldest first', () => {
    const audit = auditKrakenLedger([
      row('L2', { refid: 'B', type: 'receive', amount: '1', balance: '2', time: 300 }),
      row('L1', { refid: 'A', type: 'spend', amount: '-1', balance: '1', time: 100 }),
    ]);
    expect(audit.unpairedOperations.map((o) => o.refid)).toEqual(['A', 'B']);
  });
});

describe('KrakenProvider coverage claim', () => {
  const ctx = {
    institutionCode: 'kraken',
    baseCurrency: { id: 'usd', symbol: 'USD' } as never,
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
  };

  async function walk(ledger: Record<string, KrakenLedgerEntry>) {
    const api = {
      async fetchLedgers() {
        return { ledger, count: Object.keys(ledger).length };
      },
    } as unknown as KrakenApiService;
    const provider = new KrakenProvider(api) as unknown as {
      fetchHistoryPaginated: (
        c: unknown
      ) => AsyncGenerator<unknown, { hasCompleteTxHistory: boolean; reason?: string }, void>;
    };
    const generator = provider.fetchHistoryPaginated(ctx);
    while (true) {
      const step = await generator.next();
      if (step.done) return step.value;
    }
  }

  test('a self-consistent ledger still claims complete history', async () => {
    expect(
      await walk({
        L1: row('L1', {
          refid: 'T1',
          type: 'spend',
          asset: 'XETH',
          amount: '-1.0000',
          balance: '0.0000',
        }).entry,
        L2: row('L2', {
          refid: 'T1',
          type: 'receive',
          asset: 'ZUSD',
          amount: '3000.0000',
          balance: '3000.0000',
        }).entry,
      })
    ).toEqual({ hasCompleteTxHistory: true });
  });

  test('a ledger missing a counter leg retracts the claim', async () => {
    // The whole point of SC-392: without this the walk returns
    // `true` over a feed that never mentions the asset on the other
    // side, and `CostBasisService` labels that basis `complete`.
    expect(
      await walk({
        L1: row('L1', {
          refid: 'TS6JBSQ-MTBTI-4B3RF7',
          type: 'spend',
          asset: 'XXBT',
          amount: '-0.0539012900',
          balance: '0.0000000000',
        }).entry,
      })
    ).toEqual({
      hasCompleteTxHistory: false,
      // The reason is asserted, not just the boolean: it is what the run
      // puts in front of a person whose cost basis just changed, and a
      // false with no explanation is the shape SC-395 was cleaning up.
      reason:
        "kraken: the ledger contradicts itself over the 1 entries returned — 0 break(s) in Kraken's own running balance and 1 leg(s) of two-legged operations whose other side never arrived",
    });
  });
});
