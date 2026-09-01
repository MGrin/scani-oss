process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  type CostBasisAtTime,
  CostBasisService,
  type DisposalLotMatch,
} from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * One holding must not walk two ways (SC-344).
 *
 * `CostBasisService` exposes two entry points — `walkLots` for a holding on its
 * own and `walkComponent` for a set joined by `transfer_group_id`. A component
 * of ONE holding is the input both can be handed, and for a long time they
 * disagreed about it: one production SOL holding reported realized 26.78
 * through the portfolio walk and 26.25 through the per-disposal ledger, stable
 * to the cent across three separate database states, so not the row-order
 * artifact SC-342 closed.
 *
 * Nothing failed. Both numbers were computed, both were shown to the user —
 * the chart, `portfolio_value_daily` and both exports take the first, the
 * holding-detail ledger takes the second — and the only signal that one of them
 * was wrong was that they were not the same.
 *
 * So this asserts the property directly rather than the arithmetic: **a
 * component of one holding is indistinguishable from that holding walked
 * alone.** It is now true by construction (both entry points fold the same
 * private walk), and this is the guard that says so — a future fork of the two
 * folds fails here rather than in production six months later.
 *
 * Verified RED against the pre-SC-344 walkers: `agree on every generated
 * history` failed on well over a third of the generated histories, and the
 * round-trip fixture below reported realized -1,900 through `walkLots` against
 * 500 through `walkComponent` — 2,700 of cost invented by re-minting a
 * returning lot at the inflow leg's price.
 */

const USD = 'token-USD';
const SOL = 'token-SOL';
const HOLDING = 'holding-A';

// Every fixture prices in the base currency, so no FX route is ever needed.
// A test that reaches for one fails loudly instead of silently valuing at zero.
function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async () => {
      throw new Error('PriceGraphService.convert should not be called');
    },
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

interface Template {
  name: string;
  kind: string;
  quantity: string;
  priceNative?: string;
  transferGroupId?: string;
  transferReview?: string;
}

/**
 * The event alphabet. Chosen to reach every branch the two folds used to
 * differ on, not to be exhaustive:
 *
 *   - `out-g1` + `in-g1` at one instant is the self-spanning no-op — one
 *     on-chain transaction with the wallet on both sides. 47 of the 65
 *     production transfer groups are that shape. The old `walkLots` popped the
 *     lots, DISCARDED them and minted a fresh lot at the transfer date's
 *     market value, destroying cost basis on a move the position never felt.
 *   - `in-g1` before `out-g1` leaves the outflow's lots buffered with no
 *     partner, which is the end-of-walk branch — and `out-g1-lc` is the one
 *     row that realizes there, because it also carries `left_control`.
 *   - `sell` after any of those is what makes an inherited lot's older
 *     acquisition date observable: `lots.shift()` and a minimum-date scan
 *     agree only while the pool stays date-sorted.
 */
const TEMPLATES: readonly Template[] = [
  { name: 'buy', kind: 'buy', quantity: '10', priceNative: '100' },
  { name: 'reward', kind: 'reward', quantity: '5', priceNative: '120' },
  { name: 'sell', kind: 'sell', quantity: '-4', priceNative: '150' },
  { name: 'out-g1', kind: 'transfer_out', quantity: '-3', transferGroupId: 'g1' },
  { name: 'in-g1', kind: 'transfer_in', quantity: '3', priceNative: '200', transferGroupId: 'g1' },
  {
    name: 'out-g1-lc',
    kind: 'transfer_out',
    quantity: '-3',
    priceNative: '180',
    transferGroupId: 'g1',
    transferReview: 'left_control',
  },
  {
    name: 'out-lc',
    kind: 'transfer_out',
    quantity: '-2',
    priceNative: '170',
    transferReview: 'left_control',
  },
  { name: 'out-open', kind: 'transfer_out', quantity: '-2' },
];

/**
 * How the generated events are spread over time. `[0, 0, 0]` and `[0, 0, 1]`
 * are the layouts that matter: the two legs of a same-instant pair only sort
 * out-before-in because `compareLedgerEvents` ranks them, and a history where
 * every event is distinct in time never exercises that.
 */
const DAY_LAYOUTS: ReadonlyArray<readonly number[]> = [
  [0, 1, 2],
  [0, 0, 1],
  [0, 1, 1],
  [0, 0, 0],
];

const BASE = Date.UTC(2025, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

function txFrom(t: Template, index: number, dayOffset: number): HoldingTransaction {
  return {
    id: `tx-${index}`,
    userId: 'u',
    holdingId: HOLDING,
    tokenId: SOL,
    kind: t.kind,
    quantity: t.quantity,
    priceNative: t.priceNative ?? null,
    priceNativeTokenId: t.priceNative ? USD : null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(BASE + dayOffset * DAY),
    // Distinct and increasing with position, so the canonical order over a
    // same-instant group is the order the generator laid them out — the
    // histories differ by their events, never by an unresolved tie.
    externalId: `ext-${String(index).padStart(3, '0')}`,
    swapGroupId: null,
    transferGroupId: t.transferGroupId ?? null,
    transferReview: t.transferReview ?? null,
    transferReviewedAt: t.transferReview ? new Date(BASE) : null,
    source: 'solana',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
  } as HoldingTransaction;
}

/** Far enough ahead that `walkComponent`'s `at` filter drops nothing. */
const FUTURE = new Date(BASE + 400 * DAY);

/** Everything a caller can observe, flattened so a mismatch names itself. */
function snapshot(r: CostBasisAtTime, ledger: DisposalLotMatch[]): unknown {
  const d = (x: Decimal | null): string | null => (x === null ? null : x.toFixed(12));
  return {
    openQty: d(r.openQty),
    costBasis: d(r.costBasis),
    realizedPnl: d(r.realizedPnl),
    hasTransactions: r.hasTransactions,
    basisQuality: r.basisQuality,
    transfersUnreviewed: r.transfersUnreviewed,
    lots: r.lots.map((l) => ({
      qty: d(l.qty),
      cost: d(l.cost),
      date: l.date.toISOString(),
      stale: l.stale ?? false,
      unpriced: l.unpriced ?? false,
    })),
    // The ledger's own order differs legitimately — `walkComponent` emits
    // half-linked outflows in an end-of-walk pass, which is why
    // RealizedLedgerService sorts. Sorted here for the same reason.
    ledger: ledger
      .map((m) => ({
        transactionId: m.transactionId,
        holdingId: m.holdingId,
        kind: m.kind,
        portion: `${m.portionIndex}/${m.portionCount}`,
        acquiredAt: m.acquiredAt?.toISOString() ?? null,
        quantity: d(m.quantity),
        proceeds: d(m.proceeds),
        costBasis: d(m.costBasis),
        gain: d(m.gain),
        holdingDays: m.holdingDays,
        basisQuality: m.basisQuality,
        outcome: m.outcome,
        answerSource: m.answerSource,
      }))
      .sort((a, b) =>
        (a.transactionId + a.portion + a.acquiredAt).localeCompare(
          b.transactionId + b.portion + b.acquiredAt
        )
      ),
  };
}

/**
 * The figures a walk reports, with lot and ledger granularity projected away.
 * Used by the no-op invariant, where a re-homed lot legitimately splits one row
 * into two without moving any number — see that test.
 */
function money(r: CostBasisAtTime, ledger: DisposalLotMatch[]): unknown {
  const total = (pick: (m: DisposalLotMatch) => Decimal | null): string =>
    ledger.reduce((s, m) => s.add(pick(m) ?? new Decimal(0)), new Decimal(0)).toFixed(12);
  return {
    openQty: r.openQty.toFixed(12),
    costBasis: r.costBasis.toFixed(12),
    realizedPnl: r.realizedPnl.toFixed(12),
    basisQuality: r.basisQuality,
    transfersUnreviewed: r.transfersUnreviewed,
    lotQty: r.lots.reduce((s, l) => s.add(l.qty), new Decimal(0)).toFixed(12),
    lotCost: r.lots.reduce((s, l) => s.add(l.cost), new Decimal(0)).toFixed(12),
    lotDates: [...new Set(r.lots.map((l) => l.date.toISOString()))].sort(),
    ledgerGain: total((m) => m.gain),
    ledgerProceeds: total((m) => m.proceeds),
    ledgerCost: total((m) => m.costBasis),
    ledgerQty: total((m) => m.quantity),
    outcomes: [...new Set(ledger.map((m) => m.outcome))].sort(),
  };
}

async function bothWalks(txs: ReadonlyArray<HoldingTransaction>): Promise<{
  lots: unknown;
  component: unknown;
  money: unknown;
  realizedLots: Decimal;
  realizedComponent: Decimal;
  ledgerLots: DisposalLotMatch[];
  ledgerComponent: DisposalLotMatch[];
}> {
  const svc = makeService();
  const ledgerA: DisposalLotMatch[] = [];
  const a = await svc.walkLots(undefined, txs, USD, SOL, undefined, 'complete', ledgerA);
  const ledgerB: DisposalLotMatch[] = [];
  const walked = await svc.walkComponent(
    undefined,
    [HOLDING],
    new Map([[HOLDING, txs]]),
    FUTURE,
    USD,
    new Map([[HOLDING, SOL]]),
    undefined,
    new Map([[HOLDING, 'complete']]),
    ledgerB
  );
  const b = walked.get(HOLDING);
  if (!b) throw new Error('walkComponent returned no row for the requested holding');
  return {
    lots: snapshot(a, ledgerA),
    component: snapshot(b, ledgerB),
    money: money(b, ledgerB),
    realizedLots: a.realizedPnl,
    realizedComponent: b.realizedPnl,
    ledgerLots: ledgerA,
    ledgerComponent: ledgerB,
  };
}

function histories(): Array<{ label: string; txs: HoldingTransaction[] }> {
  const out: Array<{ label: string; txs: HoldingTransaction[] }> = [];
  for (const layout of DAY_LAYOUTS) {
    for (const a of TEMPLATES) {
      for (const b of TEMPLATES) {
        for (const c of TEMPLATES) {
          const picked = [a, b, c];
          out.push({
            label: `${picked.map((p) => p.name).join('→')} @ ${layout.join(',')}`,
            txs: picked.map((p, i) => txFrom(p, i, layout[i] ?? 0)),
          });
        }
      }
    }
  }
  return out;
}

describe('a component of one holding walks exactly as that holding alone (SC-344)', () => {
  const all = histories();

  test('the generator reaches the branches this is about', () => {
    expect(all.length).toBe(DAY_LAYOUTS.length * TEMPLATES.length ** 3);
    // Without these three counts the suite could pass by generating nothing
    // interesting. Each is a divergence the old pair of folds actually had.
    const sameInstantPair = all.filter(({ txs }) => {
      const out = txs.find((t) => t.kind === 'transfer_out' && t.transferGroupId === 'g1');
      const inn = txs.find((t) => t.kind === 'transfer_in' && t.transferGroupId === 'g1');
      return out && inn && out.occurredAt.getTime() === inn.occurredAt.getTime();
    });
    const inBeforeOut = all.filter(({ txs }) => {
      const out = txs.find((t) => t.kind === 'transfer_out' && t.transferGroupId === 'g1');
      const inn = txs.find((t) => t.kind === 'transfer_in' && t.transferGroupId === 'g1');
      return out && inn && inn.occurredAt.getTime() < out.occurredAt.getTime();
    });
    const unpairedLeftControl = all.filter(
      ({ txs }) =>
        txs.some((t) => t.transferReview === 'left_control' && t.transferGroupId === 'g1') &&
        !txs.some((t) => t.kind === 'transfer_in' && t.transferGroupId === 'g1')
    );
    expect(sameInstantPair.length).toBeGreaterThan(100);
    expect(inBeforeOut.length).toBeGreaterThan(20);
    expect(unpairedLeftControl.length).toBeGreaterThan(100);
  });

  test('agree on every generated history', async () => {
    const disagreed: string[] = [];
    for (const { label, txs } of all) {
      const { lots, component, realizedLots, realizedComponent } = await bothWalks(txs);
      if (JSON.stringify(lots) !== JSON.stringify(component)) {
        disagreed.push(
          `${label}  realized ${realizedLots.toFixed(4)} vs ${realizedComponent.toFixed(4)}`
        );
      }
    }
    // Count and examples in one assertion: a failure should say how wide the
    // fork is as well as what it looks like, and a second `expect` after a
    // failing one never runs to report it.
    expect({ count: disagreed.length, examples: disagreed.slice(0, 6) }).toEqual({
      count: 0,
      examples: [],
    });
  });
});

/**
 * The ledger explains the scalar it sits under — as a property, not a sample.
 *
 * `CostBasisDisposals.test.ts` calls `gainTotal(...) === realizedPnl` its
 * load-bearing assertion, and it is, but every one of its checks is a
 * hand-built fixture: the invariant is only ever asserted on histories someone
 * thought to write down. The generator above already builds 2,048, and it
 * asserts something different — that the two entry points agree with *each
 * other*. Since SC-344 both fold the same private walk, so agreement is close
 * to true by construction, and a walk whose rows did not add up to its own
 * scalar would agree with itself and pass.
 *
 * That is the gap this closes. The two facts are independent: agreement says
 * the folds have not forked, this says the working reproduces the answer. A
 * disposal ledger's whole claim is that it is the arithmetic behind the number
 * the chart, `portfolio_value_daily` and both exports already show — so the
 * number is the fixed point, and any future change that moves rows without
 * moving the scalar (or the reverse) has to fail here rather than on the
 * screen someone opened to resolve a doubt.
 *
 * Asserted per walker, not on the pair. A shared regression is exactly the
 * kind an agreement test cannot see.
 */
describe("a walk's rows sum to the walk's own realized scalar (SC-90)", () => {
  const all = histories();

  test('on every generated history, through both entry points', async () => {
    const broke: string[] = [];
    for (const { label, txs } of all) {
      const { realizedLots, realizedComponent, ledgerLots, ledgerComponent } = await bothWalks(txs);
      for (const [entry, scalar, ledger] of [
        ['walkLots', realizedLots, ledgerLots],
        ['walkComponent', realizedComponent, ledgerComponent],
      ] as const) {
        // Null gains are the rows that booked nothing — an unreviewed
        // withdrawal, an unpriceable swap, an outflow still waiting on its
        // pair. They contribute nothing on purpose, and treating null as zero
        // here is what lets the sum be exact rather than approximate.
        const summed = ledger.reduce((sum, m) => (m.gain ? sum.add(m.gain) : sum), new Decimal(0));
        if (!summed.equals(scalar)) {
          broke.push(
            `${entry}  ${label}  rows ${summed.toFixed(12)} vs scalar ${scalar.toFixed(12)}`
          );
        }
      }
    }
    expect({ count: broke.length, examples: broke.slice(0, 6) }).toEqual({
      count: 0,
      examples: [],
    });
  });

  test('the histories that book money are a real share of them', async () => {
    // Without this the property above passes on 2,048 walks that all realize
    // 0.00 against no rows, which is an invariant holding vacuously.
    let realizing = 0;
    for (const { txs } of all) {
      const { realizedLots } = await bothWalks(txs);
      if (!realizedLots.isZero()) realizing += 1;
    }
    expect(realizing).toBeGreaterThan(all.length / 4);
  });
});

describe('a self-spanning transfer group is a no-op (SC-344)', () => {
  // One on-chain transaction with the holding's own wallet on both sides —
  // production carries 47 of them, and the four on the SOL holding this ticket
  // came from share a Solana signature between their two legs. The position
  // never changed, so the walk over the full history must equal the walk with
  // the pair deleted. That equality is what establishes 26.78 as the correct
  // figure and 26.25 as the wrong one, independently of which walker is nicer
  // to read.
  const buy = txFrom({ name: 'buy', kind: 'buy', quantity: '10', priceNative: '100' }, 0, 0);
  const roundTrip = [
    txFrom({ name: 'out-g1', kind: 'transfer_out', quantity: '-3', transferGroupId: 'g1' }, 1, 5),
    txFrom(
      {
        name: 'in-g1',
        kind: 'transfer_in',
        quantity: '3',
        priceNative: '900',
        transferGroupId: 'g1',
      },
      2,
      5
    ),
  ];
  const sell = txFrom({ name: 'sell', kind: 'sell', quantity: '-10', priceNative: '150' }, 3, 9);

  test('deleting the pair changes no figure, through either entry point', async () => {
    const withPair = await bothWalks([buy, ...roundTrip, sell]);
    const withoutPair = await bothWalks([buy, sell]);
    // Every FIGURE, not every row. A lot that is popped for the outflow leg and
    // re-homed by the inflow leg comes back as its own lot — 10 becomes 7 + 3,
    // same acquisition date, same cost between them — so a later disposal
    // matches two slices where it would otherwise match one, and the ledger has
    // one more row. The walk does not coalesce lots and has no reason to: the
    // date is what FIFO orders on and it is unchanged, so no figure moves. What
    // must not differ is the money, and that is what this compares.
    expect(withPair.money).toEqual(withoutPair.money);
  });

  test('the round trip neither destroys cost basis nor realizes a gain', async () => {
    // 10 bought at 100 = 1,000; all 10 sold at 150 = 1,500. The 3 that left and
    // came back are the same 3, so realized is 500 and not a penny of it comes
    // from re-valuing them at the 900 the inflow leg carries. Minting a fresh
    // lot there is what produced the small but real discrepancy in production.
    // At this fixture's scale the same defect is 3 lots re-valued at the 900 the
    // inflow leg carries, so it would be visible as 2,700 of invented cost.
    const r = await bothWalks([buy, ...roundTrip, sell]);
    expect(r.realizedLots.toFixed(2)).toBe('500.00');
    expect(r.realizedComponent.toFixed(2)).toBe('500.00');
  });
});
