process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingCoverage, HoldingTransaction } from '@scani/db/schema';
import { DISPOSAL_OUTCOMES } from '@scani/shared';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PeriodDisposalsService } from '../../../src/services/portfolio/PeriodDisposalsService';
import { RealizedLedgerService } from '../../../src/services/portfolio/RealizedLedgerService';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * `PeriodDisposalsService` — SC-90's (a) and (b).
 *
 * The arithmetic belongs to `CostBasisService` and is pinned next door. What
 * this service adds is two things, and each of them can be wrong in a way that
 * produces a plausible non-empty answer:
 *
 * 1. **A lower bound on the ROWS.** Applied to the walk's output. Applied to
 *    its input instead, every disposal in the window would find no acquisition
 *    lot, report a zero cost basis, and book its whole proceeds as gain — a
 *    uniformly overstated figure with nothing in it that looks wrong.
 * 2. **Enumeration of the whole portfolio.** A component walked from one seed
 *    reports only that seed's slice; two unrelated holdings must both appear.
 *
 * Every assertion below is paired with an arm that must read the OPPOSITE. A
 * window test whose fixture has no disposals passes trivially, and two arms
 * that agree are one measurement taken twice.
 */

const USD = 'token-USD';
const BTC = 'token-BTC';

let txSeq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  transferGroupId?: string;
  transferReview?: string;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `tx-${txSeq}`,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: BTC,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNative ? USD : null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
    transferReview: p.transferReview ?? null,
    transferReviewedAt: p.transferReview ? new Date() : null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

interface Harness {
  service: PeriodDisposalsService;
  /** How many times the ledger was asked to walk a component. */
  componentWalks: () => number;
}

function makeService(opts: {
  /** What `findIdsForUser` returns — the enumeration under test. */
  userHoldingIds: string[];
  /** Transfer component membership, keyed by seed holding id. */
  componentOf?: (seed: string) => string[];
  txsByHolding: Map<string, HoldingTransaction[]>;
  coverage?: Map<string, HoldingCoverage>;
}): Harness {
  let walks = 0;
  Container.set(HoldingTransactionRepository, {
    findTransferLinkedHoldingIds: async (_userId: string, ids: string[]) =>
      opts.componentOf ? opts.componentOf(ids[0] as string) : [ids[0] as string],
    findForHoldingsAll: async (ids: string[]) => {
      walks += 1;
      const out = new Map<string, HoldingTransaction[]>();
      for (const id of ids) out.set(id, opts.txsByHolding.get(id) ?? []);
      return out;
    },
    // `getCostBasis` prefers the handed-in `txs`, so this must never fire.
    findForHoldingUpTo: async () => {
      throw new Error('findForHoldingUpTo should not be called — txs are pre-loaded');
    },
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findIdsForUser: async () => opts.userHoldingIds,
    findByIds: async (ids: string[]) => ids.map((id) => ({ id, tokenId: BTC })),
    findById: async () => {
      throw new Error('findById should not be called — heldTokenId is pre-resolved');
    },
  } as unknown as HoldingRepository);
  Container.set(HoldingCoverageRepository, {
    findManyByHoldingIds: async () => opts.coverage ?? new Map(),
  } as unknown as HoldingCoverageRepository);
  Container.set(PriceGraphService, {
    convert: async () => {
      throw new Error('PriceGraphService.convert should not be called in these tests');
    },
  } as unknown as PriceGraphService);
  Container.set(CostBasisService, new CostBasisService());
  const ledger = new RealizedLedgerService();
  Container.set(RealizedLedgerService, ledger);
  const service = new PeriodDisposalsService();
  Container.set(PeriodDisposalsService, service);
  return { service, componentWalks: () => walks };
}

const Y2023 = { from: new Date('2023-01-01T00:00:00Z'), to: new Date('2024-01-01T00:00:00Z') };
const Y2024 = { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2025-01-01T00:00:00Z') };
const Y2022 = { from: new Date('2022-01-01T00:00:00Z'), to: new Date('2023-01-01T00:00:00Z') };
/** After every fixture instant, so the walk is never the thing doing the filtering. */
const ASOF = new Date('2030-01-01T00:00:00Z');

/** buy 4 @100 in 2023, sell 2 @200 in 2023, sell 2 @200 in 2024. */
function twoYearsOfDisposals(): Map<string, HoldingTransaction[]> {
  return new Map([
    [
      'h',
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '4',
          occurredAt: '2023-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-2',
          occurredAt: '2023-06-01',
          priceNative: '200',
        }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-2',
          occurredAt: '2024-06-01',
          priceNative: '200',
        }),
      ],
    ],
  ]);
}

describe('PeriodDisposalsService.forPeriod — the window bounds the ROWS', () => {
  test('reports the disposals inside the window and no others', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: twoYearsOfDisposals(),
    });

    const y2024 = await service.forPeriod('u', USD, Y2024, undefined, ASOF);
    const y2023 = await service.forPeriod('u', USD, Y2023, undefined, ASOF);

    // must-be-FOUND: each window sees exactly its own disposal...
    expect(y2024.rows).toHaveLength(1);
    expect(y2024.rows[0]?.disposedAt.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(y2023.rows).toHaveLength(1);
    expect(y2023.rows[0]?.disposedAt.toISOString()).toBe('2023-06-01T00:00:00.000Z');

    // ...and the two arms DISAGREE, which is what makes either one a
    // measurement. A filter that did nothing returns both rows to both
    // windows, and each arm alone would still look like a pass.
    expect(y2024.rows[0]?.transactionId).not.toBe(y2023.rows[0]?.transactionId);
  });

  test('a window with no disposals reports zero — over a ledger that demonstrably has some', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: twoYearsOfDisposals(),
    });

    const empty = await service.forPeriod('u', USD, Y2022, undefined, ASOF);
    // must-be-FOUND control, same service and same fixture: without it a zero
    // here is indistinguishable from a walk that returned nothing at all.
    const populated = await service.forPeriod('u', USD, Y2024, undefined, ASOF);

    expect(empty.rows.length).toBe(0);
    expect(populated.rows.length).toBe(1);
    expect(empty.totals.gain.toString()).toBe('0');
  });

  test('the boundary instant belongs to the later window and to one window only', async () => {
    const txs = new Map([
      [
        'h',
        [
          tx({
            holdingId: 'h',
            kind: 'buy',
            quantity: '1',
            occurredAt: '2022-06-01',
            priceNative: '100',
          }),
          // Exactly the instant both windows share.
          tx({
            holdingId: 'h',
            kind: 'sell',
            quantity: '-1',
            occurredAt: '2024-01-01T00:00:00Z',
            priceNative: '150',
          }),
        ],
      ],
    ]);
    const { service } = makeService({ userHoldingIds: ['h'], txsByHolding: txs });

    const later = await service.forPeriod('u', USD, Y2024, undefined, ASOF);
    const earlier = await service.forPeriod('u', USD, Y2023, undefined, ASOF);

    // `[from, to)` — in the window that starts on it, out of the one that ends
    // on it. The two arms must disagree; if they agreed the boundary would be
    // counted twice by anyone adding two years together, with no error to see.
    expect(later.rows.length).toBe(1);
    expect(earlier.rows.length).toBe(0);
  });
});

describe('PeriodDisposalsService.forPeriod — the window does NOT bound the walk', () => {
  test('a lot acquired years before the window still supplies the cost basis', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: new Map([
        [
          'h',
          [
            tx({
              holdingId: 'h',
              kind: 'buy',
              quantity: '4',
              occurredAt: '2023-01-01',
              priceNative: '100',
            }),
            tx({
              holdingId: 'h',
              kind: 'sell',
              quantity: '-4',
              occurredAt: '2024-06-01',
              priceNative: '200',
            }),
          ],
        ],
      ]),
    });

    const y2024 = await service.forPeriod('u', USD, Y2024, undefined, ASOF);

    expect(y2024.rows).toHaveLength(1);
    // The 2023 purchase is outside the window and is the whole point.
    expect(y2024.rows[0]?.costBasis.toString()).toBe('400');
    expect(y2024.rows[0]?.gain?.toString()).toBe('400');
    expect(y2024.rows[0]?.acquiredAt?.toISOString()).toBe('2023-01-01T00:00:00.000Z');

    // must-be-ABSENT: these are the exact figures a walk truncated at
    // `window.from` produces — no lot to match, so a zero basis and the entire
    // proceeds booked as gain. Both are plausible numbers and neither is
    // distinguishable from a real one without this arm.
    expect(y2024.rows[0]?.costBasis.toString()).not.toBe('0');
    expect(y2024.rows[0]?.gain?.toString()).not.toBe('800');
    expect(y2024.totals.gain.toString()).not.toBe('800');
  });
});

describe('PeriodDisposalsService.forPeriod — transfer-linked components', () => {
  /**
   * The path a singleton-only fixture never reaches: bought on one holding,
   * moved to another, sold there. `walkLots` cannot answer this and
   * `walkComponent` is what does.
   */
  const component = ['kraken', 'wallet'];
  function transferFixture(): Map<string, HoldingTransaction[]> {
    return new Map([
      [
        'kraken',
        [
          tx({
            holdingId: 'kraken',
            kind: 'buy',
            quantity: '10',
            occurredAt: '2023-01-01',
            priceNative: '100',
          }),
          tx({
            holdingId: 'kraken',
            kind: 'transfer_out',
            quantity: '-10',
            occurredAt: '2024-03-01',
            transferGroupId: 'g1',
          }),
        ],
      ],
      [
        'wallet',
        [
          tx({
            holdingId: 'wallet',
            kind: 'transfer_in',
            quantity: '10',
            occurredAt: '2024-03-01',
            transferGroupId: 'g1',
          }),
          tx({
            holdingId: 'wallet',
            kind: 'sell',
            quantity: '-10',
            occurredAt: '2024-06-01',
            priceNative: '300',
          }),
        ],
      ],
    ]);
  }

  test('a lot that moved across a transfer keeps the cost it was bought at', async () => {
    const { service } = makeService({
      userHoldingIds: component,
      componentOf: () => component,
      txsByHolding: transferFixture(),
    });

    const y2024 = await service.forPeriod('u', USD, Y2024, undefined, ASOF);
    const realized = y2024.rows.filter((r) => r.outcome === 'realized');

    expect(realized).toHaveLength(1);
    expect(realized[0]?.holdingId).toBe('wallet');
    // Kraken's 2023 cost, not a fresh market-value lot opened on arrival.
    expect(realized[0]?.costBasis.toString()).toBe('1000');
    expect(realized[0]?.gain?.toString()).toBe('2000');
    expect(realized[0]?.acquiredAt?.toISOString()).toBe('2023-01-01T00:00:00.000Z');

    // must-be-ABSENT: 3000 is the whole proceeds, which is what a zero-basis
    // lot would book. A per-holding walk of `wallet` alone reports exactly
    // that, so this arm is what separates a component walk from a seed walk.
    expect(realized[0]?.gain?.toString()).not.toBe('3000');
  });

  test('the transfer_out inside the window is not itself a realized disposal', async () => {
    const { service } = makeService({
      userHoldingIds: component,
      componentOf: () => component,
      txsByHolding: transferFixture(),
    });

    const y2024 = await service.forPeriod('u', USD, Y2024, undefined, ASOF);

    // A move between the user's own accounts is not a sale. It is inside the
    // window and must not add to the realized figure.
    expect(y2024.byOutcome.realized).toBe(1);
    expect(y2024.rows.some((r) => r.kind === 'transfer_out' && r.outcome === 'realized')).toBe(
      false
    );
  });
});

describe('PeriodDisposalsService.forPeriod — portfolio-wide enumeration', () => {
  function twoUnrelatedHoldings(): Map<string, HoldingTransaction[]> {
    return new Map([
      [
        'a',
        [
          tx({
            holdingId: 'a',
            kind: 'buy',
            quantity: '1',
            occurredAt: '2023-01-01',
            priceNative: '100',
          }),
          tx({
            holdingId: 'a',
            kind: 'sell',
            quantity: '-1',
            occurredAt: '2024-06-01',
            priceNative: '150',
          }),
        ],
      ],
      [
        'b',
        [
          tx({
            holdingId: 'b',
            kind: 'buy',
            quantity: '1',
            occurredAt: '2023-01-01',
            priceNative: '200',
          }),
          tx({
            holdingId: 'b',
            kind: 'sell',
            quantity: '-1',
            occurredAt: '2024-07-01',
            priceNative: '500',
          }),
        ],
      ],
    ]);
  }

  test('every holding the user has contributes, and the enumeration is what widens it', async () => {
    const both = makeService({ userHoldingIds: ['a', 'b'], txsByHolding: twoUnrelatedHoldings() });
    const result = await both.service.forPeriod('u', USD, Y2024, undefined, ASOF);

    expect(result.rows.length).toBe(2);
    expect(new Set(result.rows.map((r) => r.holdingId))).toEqual(new Set(['a', 'b']));
    expect(result.totals.gain.toString()).toBe('350'); // 50 + 300

    // must-be-DISAGREE control: the SAME fixture with a narrower enumeration
    // must return less. Without it, a service that ignored `findIdsForUser`
    // and walked everything it could find would pass the arm above.
    const one = makeService({ userHoldingIds: ['a'], txsByHolding: twoUnrelatedHoldings() });
    const narrowed = await one.service.forPeriod('u', USD, Y2024, undefined, ASOF);
    expect(narrowed.rows.length).toBe(1);
    expect(narrowed.rows[0]?.holdingId).toBe('a');
    expect(narrowed.totals.gain.toString()).toBe('50');
  });

  test('a user with no holdings reports zeroes without walking anything', async () => {
    const none = makeService({ userHoldingIds: [], txsByHolding: new Map() });
    const result = await none.service.forPeriod('u', USD, Y2024, undefined, ASOF);

    expect(result.rows.length).toBe(0);
    expect(none.componentWalks()).toBe(0);

    // must-be-FOUND control: the counter does move when there IS a holding, so
    // the zero above is a measurement rather than a counter that never
    // increments.
    const one = makeService({ userHoldingIds: ['a'], txsByHolding: twoUnrelatedHoldings() });
    await one.service.forPeriod('u', USD, Y2024, undefined, ASOF);
    expect(one.componentWalks()).toBeGreaterThan(0);
  });
});

describe('PeriodDisposalsService.forPeriod — totals and buckets', () => {
  /** buy 4 @100; sell 2 @200 (realized); withdraw 2 with no answer (unreviewed). */
  function realizedAndUnreviewed(): Map<string, HoldingTransaction[]> {
    return new Map([
      [
        'h',
        [
          tx({
            holdingId: 'h',
            kind: 'buy',
            quantity: '4',
            occurredAt: '2023-01-01',
            priceNative: '100',
          }),
          tx({
            holdingId: 'h',
            kind: 'sell',
            quantity: '-2',
            occurredAt: '2024-06-01',
            priceNative: '200',
          }),
          tx({ holdingId: 'h', kind: 'withdraw', quantity: '-2', occurredAt: '2024-07-01' }),
        ],
      ],
    ]);
  }

  test('every bucket sums to rowCount, so a row cannot fall out of the census', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: realizedAndUnreviewed(),
    });
    const result = await service.forPeriod('u', USD, Y2024, undefined, ASOF);

    const outcomeSum = Object.values(result.byOutcome).reduce((a, b) => a + b, 0);
    const qualitySum = Object.values(result.byBasisQuality).reduce((a, b) => a + b, 0);

    expect(result.rows.length).toBe(2);
    expect(outcomeSum).toBe(result.rows.length);
    expect(qualitySum).toBe(result.rows.length);
    // The population is non-empty, so the two sums above are comparing
    // something. `0 === 0 === 0` would satisfy them over a walk that returned
    // nothing.
    expect(result.rows.length).toBeGreaterThan(0);
  });

  test('gain is summed over the rows that realized, not derived from proceeds minus cost', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: realizedAndUnreviewed(),
    });
    const result = await service.forPeriod('u', USD, Y2024, undefined, ASOF);

    expect(result.byOutcome.realized).toBe(1);
    expect(result.byOutcome.unreviewed).toBe(1);

    // The unreviewed withdrawal popped 200 of cost and booked no gain, so the
    // two figures are taken over different subsets of the rows.
    expect(result.totals.proceeds.toString()).toBe('400');
    expect(result.totals.costBasis.toString()).toBe('400');
    expect(result.totals.gain.toString()).toBe('200');

    // must-be-ABSENT: publishing `proceeds - costBasis` as the gain would read
    // 0 here — a confident figure that no row supports. This arm is the reason
    // the three totals are summed separately rather than derived.
    const derived = result.totals.proceeds.minus(result.totals.costBasis);
    expect(derived.toString()).toBe('0');
    expect(result.totals.gain.toString()).not.toBe(derived.toString());
  });

  test('the method the walk ran under is echoed back', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: realizedAndUnreviewed(),
    });

    const defaulted = await service.forPeriod('u', USD, Y2024, undefined, ASOF);
    const explicit = await service.forPeriod('u', USD, Y2024, 'uk_section_104', ASOF);

    // A figure quoted without its identification rule is one a reader cannot
    // reproduce (SC-462). The two arms must disagree, or the field is a
    // constant wearing a label.
    expect(defaulted.method).toBe('fifo');
    expect(explicit.method).toBe('uk_section_104');
  });
});

describe('the outcome census cannot silently lose a bucket', () => {
  test('byOutcome carries exactly the outcomes the contract declares', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: twoYearsOfDisposals(),
    });
    const result = await service.forPeriod('u', USD, Y2024, undefined, ASOF);

    // Adding a `DisposalOutcome` without adding a bucket would drop those rows
    // out of a census that still sums to `rowCount` — because they would land
    // on an undeclared key. This fails at that moment instead.
    expect(Object.keys(result.byOutcome).sort()).toEqual([...DISPOSAL_OUTCOMES].sort());

    // must-be-FOUND: the comparison above can fail. Without this, an
    // assertion between two empty arrays would read identically.
    expect(DISPOSAL_OUTCOMES.length).toBeGreaterThan(0);
    expect(Object.keys(result.byOutcome).sort()).not.toEqual(
      [...DISPOSAL_OUTCOMES, 'not_an_outcome'].sort()
    );
  });
});

describe('PeriodDisposalsService.forPeriod — the upper bound is `asOf`, not `window.to`', () => {
  /**
   * The two bounds are deliberately NOT symmetric, and this is the arm that
   * says so. Under `uk_section_104` a disposal matches acquisitions in the
   * FOLLOWING 30 days (TCGA92/S106A(5)), so a sale in the last month of a
   * window is identified against a purchase that has not happened yet at
   * `window.to`. Walking only up to `window.to` truncates that reach for every
   * such disposal and silently substitutes the pooled cost instead — a
   * different, wrong, entirely plausible figure.
   */
  function saleThenRepurchaseSixteenDaysLater(): Map<string, HoldingTransaction[]> {
    return new Map([
      [
        'h',
        [
          tx({
            holdingId: 'h',
            kind: 'buy',
            quantity: '1',
            occurredAt: '2023-01-01',
            priceNative: '100',
          }),
          tx({
            holdingId: 'h',
            kind: 'sell',
            quantity: '-1',
            occurredAt: '2024-12-20',
            priceNative: '300',
          }),
          // Inside the 30-day window, outside the reporting window.
          tx({
            holdingId: 'h',
            kind: 'buy',
            quantity: '1',
            occurredAt: '2025-01-05',
            priceNative: '250',
          }),
        ],
      ],
    ]);
  }

  test('a repurchase after the window still identifies a disposal inside it', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: saleThenRepurchaseSixteenDaysLater(),
    });

    const s104 = await service.forPeriod('u', USD, Y2024, 'uk_section_104', ASOF);

    expect(s104.rows).toHaveLength(1);
    // The 2025 repurchase, reached forwards across `periodEnd`.
    expect(s104.rows[0]?.costBasis.toString()).toBe('250');
    expect(s104.rows[0]?.gain?.toString()).toBe('50');

    // must-be-ABSENT: 100 is the 2023 pooled cost, which is what the walk
    // falls back to when the repurchase is not visible — i.e. exactly what
    // passing `window.to` as the walk's `at` produces. It is a number, it is
    // in the right currency, and nothing about it looks truncated.
    expect(s104.rows[0]?.costBasis.toString()).not.toBe('100');
  });

  test('the same fixture under fifo reads differently, so the arm above is measuring the rule', async () => {
    const { service } = makeService({
      userHoldingIds: ['h'],
      txsByHolding: saleThenRepurchaseSixteenDaysLater(),
    });

    const fifo = await service.forPeriod('u', USD, Y2024, 'fifo', ASOF);

    // fifo has no forward reach at all: the 2023 lot, at the cost it was
    // bought for. The two methods DISAGREE on one fixture, which is what makes
    // the 250 above attributable to the forward match rather than to an
    // accident of ordering.
    expect(fifo.rows[0]?.costBasis.toString()).toBe('100');
    expect(fifo.rows[0]?.gain?.toString()).toBe('200');
  });
});
