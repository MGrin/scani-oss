import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildDemoDataset } from '../../src/demo/dataset';
import { DEMO_ANCHOR_DATE, DEMO_HISTORY_DAYS } from '../../src/demo/persona';
import { sourceForChainId } from '../../src/services/transactions/transaction-source';

const dataset = buildDemoDataset();

describe('demo dataset — determinism', () => {
  it('produces a byte-identical plan on a second build', () => {
    // The whole contract of this dataset in one assertion. A visual baseline
    // and a landing screenshot both survive a reset only if this holds, and
    // the ways it breaks are quiet: an unseeded `Math.random`, a
    // `defaultRandom()` id, a `new Date()` anywhere in the build.
    expect(JSON.stringify(buildDemoDataset())).toBe(JSON.stringify(dataset));
  });

  it('is a function of the anchor, not of the calendar', () => {
    const shifted = buildDemoDataset({ anchorDate: '2026-08-21' });
    expect(shifted.anchorDate).toBe('2026-08-21');
    expect(shifted.startDate).not.toBe(dataset.startDate);
    expect(JSON.stringify(buildDemoDataset({ anchorDate: '2026-08-21' }))).toBe(
      JSON.stringify(shifted)
    );
  });

  it('covers the window it claims to', () => {
    expect(dataset.anchorDate).toBe(DEMO_ANCHOR_DATE);
    expect(dataset.days).toBe(DEMO_HISTORY_DAYS);
    const userRows = dataset.rollups.filter((row) => row.scopeKind === 'user');
    expect(userRows.length).toBe(DEMO_HISTORY_DAYS);
    expect(userRows.at(0)?.snapshotDate).toBe(dataset.startDate);
    expect(userRows.at(-1)?.snapshotDate).toBe(dataset.anchorDate);
  });
});

describe('demo dataset — the ledger is the source of truth', () => {
  it('gives every holding the balance its transactions add up to', () => {
    for (const holding of dataset.holdings) {
      const summed = dataset.transactions
        .filter((tx) => tx.holdingKey === holding.key)
        .reduce((total, tx) => total + Number(tx.quantity), 0);
      expect(Number(holding.balance)).toBeCloseTo(summed, 6);
    }
  });

  it('never lets a position go negative on any day of the window', () => {
    // A cash account spending money before it arrives draws a net-worth chart
    // that dips below zero, which is the single most obviously fake thing a
    // portfolio can do — and it is invisible until the rows are summed.
    for (const row of dataset.rollups) {
      expect(Number(row.totalValue)).toBeGreaterThanOrEqual(0);
    }
  });

  it('sums the per-holding rows into the user row for every day', () => {
    const holdingTotals = new Map<string, number>();
    for (const row of dataset.rollups) {
      if (row.scopeKind !== 'holding') continue;
      holdingTotals.set(
        row.snapshotDate,
        (holdingTotals.get(row.snapshotDate) ?? 0) + Number(row.totalValue)
      );
    }
    for (const row of dataset.rollups) {
      if (row.scopeKind !== 'user') continue;
      expect(Number(row.totalValue)).toBeCloseTo(holdingTotals.get(row.snapshotDate) ?? 0, 1);
    }
  });

  it('prices every held symbol on every day of the window', () => {
    const priced = new Set(dataset.prices.map((row) => `${row.symbol}|${row.at.toISOString()}`));
    const days = new Set(dataset.prices.map((row) => row.at.toISOString()));
    expect(days.size).toBe(dataset.days);
    for (const holding of dataset.holdings) {
      if (holding.symbol === 'GBP') continue; // the base currency quotes itself
      for (const day of days) expect(priced.has(`${holding.symbol}|${day}`)).toBe(true);
    }
  });
});

describe('demo dataset — every surface has something on it', () => {
  it('leaves exactly the transfers meant to be unanswered in the queue', () => {
    // `/review` counts outflows with no pair and no answer. Zero makes the
    // queue look like a feature nobody uses; a hundred buries it.
    const queued = dataset.transactions.filter(
      (tx) =>
        (tx.kind === 'withdraw' || tx.kind === 'transfer_out') &&
        !tx.transferGroupId &&
        !tx.transferReview
    );
    expect(queued.length).toBe(3);
    expect(new Set(queued.map((tx) => tx.symbol)).size).toBe(3);
  });

  it('answers the settled bills so they do not crowd the queue', () => {
    const answered = dataset.transactions.filter((tx) => tx.transferReview === 'left_control');
    expect(answered.length).toBeGreaterThan(50);
    for (const tx of answered) {
      expect(tx.transferReviewedAt).not.toBeNull();
      expect(tx.transferReviewSource).toBe('user');
    }
  });

  it('has one invoice extraction waiting to be confirmed', () => {
    expect(dataset.extractions.filter((row) => row.reviewState === 'pending')).toHaveLength(1);
    expect(dataset.extractions.filter((row) => row.reviewState === 'accepted')).toHaveLength(1);
    expect(dataset.documents.length).toBe(dataset.extractions.length);
  });

  it('points every settled occurrence at the ledger row that settled it', () => {
    const matched = dataset.occurrences.filter((row) => row.status === 'matched');
    expect(matched.length).toBeGreaterThan(100);
    for (const row of matched) expect(row.transactionId).not.toBeNull();
  });

  it('leaves scheduled occurrences ahead of the anchor and none behind it', () => {
    for (const row of dataset.occurrences) {
      if (row.dueDate <= dataset.anchorDate) {
        // A past due date still marked `scheduled` renders as overdue, and
        // Money then opens on "Overdue, 14 bills" over a healthy portfolio.
        expect(row.status).toBe('matched');
      } else {
        expect(row.status).toBe('scheduled');
        expect(row.actualAmount).toBeNull();
      }
    }
    expect(dataset.occurrences.some((row) => row.dueDate > dataset.anchorDate)).toBe(true);
  });

  it('spans three currencies, three chains and both directions of Money', () => {
    expect(new Set(dataset.payments.map((row) => row.currency))).toEqual(new Set(['GBP', 'EUR']));
    expect(new Set(dataset.payments.map((row) => row.direction))).toEqual(
      new Set(['outflow', 'inflow'])
    );
    expect(dataset.wallets).toHaveLength(3);
    expect(new Set(dataset.wallets.map((row) => row.institution)).size).toBe(3);
  });

  it('gives the returns engine a disposal in each of two UK tax years', () => {
    // SC-90 reports per tax year and SC-462 pools under Section 104; a
    // dataset whose disposals all sit in one year exercises neither.
    const years = new Set(
      dataset.transactions
        .filter((tx) => tx.kind === 'sell')
        .map((tx) => {
          const at = tx.occurredAt;
          const beforeApril6 =
            at.getUTCMonth() < 3 || (at.getUTCMonth() === 3 && at.getUTCDate() < 6);
          return beforeApril6 ? at.getUTCFullYear() - 1 : at.getUTCFullYear();
        })
    );
    expect(years.size).toBeGreaterThanOrEqual(2);
  });

  it('has a repurchase inside 30 days of a disposal of the same asset', () => {
    const nvda = dataset.transactions
      .filter((tx) => tx.symbol === 'NVDA')
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const pairs = nvda.flatMap((sell, index) =>
      sell.kind !== 'sell'
        ? []
        : nvda
            .slice(index + 1)
            .filter(
              (buy) =>
                buy.kind === 'buy' &&
                buy.occurredAt.getTime() - sell.occurredAt.getTime() <= 30 * 86_400_000
            )
    );
    expect(pairs.length).toBeGreaterThan(0);
  });
});

describe('demo dataset — it has to survive being looked at', () => {
  it('does not repeat a gain percentage down the holdings column', () => {
    // SC-82: deriving cost basis from one per-asset-class constant made every
    // crypto row read +20.9% and every equity +9.4%. Three identical figures
    // in a column is what makes a screenshot read as generated.
    const finalDay = dataset.rollups.filter(
      (row) => row.scopeKind === 'holding' && row.snapshotDate === dataset.anchorDate
    );
    const gains = finalDay
      .filter((row) => Number(row.costBasis) > 0)
      .map((row) =>
        (((Number(row.totalValue) - Number(row.costBasis)) / Number(row.costBasis)) * 100).toFixed(
          1
        )
      );
    const counts = new Map<string, number>();
    for (const gain of gains) counts.set(gain, (counts.get(gain) ?? 0) + 1);
    // `0.0` is legitimately shared by the cash rows, which have no gain to
    // have; nothing else may repeat.
    for (const [gain, count] of counts) {
      if (gain === '0.0' || gain === '-0.0') continue;
      expect({ gain, count }).toEqual({ gain, count: 1 });
    }
  });

  it('draws a curve rather than a wave', () => {
    // A sinusoid satisfies every query above and photographs as a textbook
    // wave. A mean-reverting walk changes direction an irregular number of
    // times; a sine over 18 months changes it a small, even number.
    const series = dataset.rollups
      .filter((row) => row.scopeKind === 'holding' && row.scopeRef === 'ibkr-nvda')
      .map((row) => Number(row.totalValue));
    let turns = 0;
    for (let index = 2; index < series.length; index++) {
      const before = (series[index - 1] as number) - (series[index - 2] as number);
      const after = (series[index] as number) - (series[index - 1] as number);
      if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) turns++;
    }
    expect(turns).toBeGreaterThan(30);
  });

  it('ends up somewhere a working consultant could plausibly be', () => {
    const closing = dataset.rollups.find(
      (row) => row.scopeKind === 'user' && row.snapshotDate === dataset.anchorDate
    );
    expect(Number(closing?.totalValue)).toBeGreaterThan(100_000);
    expect(Number(closing?.totalValue)).toBeLessThan(1_000_000);
    expect(Number(closing?.costBasis)).toBeGreaterThan(0);
  });
});

describe('demo dataset — a wallet account is shaped like an imported one', () => {
  const walletAccounts = dataset.accounts.filter(
    (row) => (row.metadata as Record<string, unknown>).walletAddress !== undefined
  );

  it('writes every field the wallet importer writes, and no more', () => {
    // The drift guard, and the reason this reads the importer's source rather
    // than a copy of its key list: a hand-written list agrees with the
    // importer only on the day it is written. SC-864 was this seed carrying
    // one of six fields, which nothing noticed because a missing key reads as
    // `null` at every consumer and `null` reads as "not a wallet".
    const source = readFileSync(
      new URL('../../src/use-cases/ImportWalletAddressUseCase.ts', import.meta.url),
      'utf8'
    );
    const block = /accountMetadataPatch:\s*\{([^}]*)\}/.exec(source)?.[1];
    expect(block).toBeDefined();
    const importerKeys = new Set(
      [...(block as string).matchAll(/^\s*(\w+):/gm)].map((match) => match[1] as string)
    );
    // A control: the regex finding nothing would make every comparison below
    // pass against an empty set.
    expect(importerKeys.size).toBe(6);

    expect(walletAccounts).toHaveLength(3);
    for (const account of walletAccounts) {
      expect(new Set(Object.keys(account.metadata as object))).toEqual(importerKeys);
    }
  });

  it('gives each wallet a chainId the transaction pipeline actually dispatches on', () => {
    // `sourceForChainId` is the production function, so this cannot pass on a
    // plausible-looking string. Two of the three are non-EVM sentinels — `'0'`
    // and `'-2'` — which is exactly the shape a value invented from memory
    // would get wrong.
    const sources = walletAccounts.map((account) =>
      sourceForChainId((account.metadata as { chainId: string }).chainId)
    );
    expect(sources).not.toContain(null);
    expect(new Set(sources)).toEqual(new Set(['etherscan', 'bitcoin', 'solana']));
  });

  it('points each account at the user_wallets row the seeder really creates', () => {
    // `userWalletId` is what makes an account sync-owned:
    // `SyncWalletBalancesUseCase` finds its account by this field alone, and
    // `AccountService.deleteAccount` reads it to decide whether to clean up
    // the wallet. An id pointing at no row is worse than a null one.
    const walletIds = new Set(dataset.wallets.map((row) => row.id));
    expect(walletIds.size).toBe(3);
    for (const account of walletAccounts) {
      expect(walletIds).toContain((account.metadata as { userWalletId: string }).userWalletId);
    }
  });

  it('leaves the five non-wallet accounts with no metadata at all', () => {
    // The control on the assertions above, and the scope correction SC-864
    // needed: `accountMetadataPatch` has exactly one writer in the tree, the
    // WALLET importer. No bank, broker or exchange import writes account
    // metadata, so `{}` on Wise, Revolut, IBKR and Kraken is faithful and
    // copying wallet fields onto them would be a new kind of wrong.
    const others = dataset.accounts.filter((row) => !walletAccounts.includes(row));
    expect(others).toHaveLength(5);
    for (const account of others) expect(account.metadata).toEqual({});
  });

  it('still cannot make TransferReviewService offer a same_network destination', () => {
    // Recorded rather than fixed, because it is a DATASET fact and not a
    // metadata one: `same_network` needs two accounts sharing a chainId, and
    // the persona has one wallet per chain. Adding the six fields removed the
    // structural reason the band could never fire; this is the remaining one,
    // and it is filed separately. Pinned so the next reader learns it from a
    // test rather than from a two-band list that looks entirely correct.
    const chainIds = walletAccounts.map(
      (account) => (account.metadata as { chainId: string }).chainId
    );
    expect(new Set(chainIds).size).toBe(chainIds.length);
  });
});
