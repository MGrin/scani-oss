import { type CostBasisMethodDto, DEFAULT_COST_BASIS_METHOD } from '@scani/shared';
import Decimal from 'decimal.js';

/**
 * Which acquisition a disposal is matched against — the one decision the
 * cost-basis walk used to make implicitly, and the reason its numbers were
 * wrong for a UK taxpayer (SC-462).
 *
 * `CostBasisService` is a fold over a ledger. Everything else it does — what a
 * transaction is worth, whether an unlinked withdrawal is a disposal at all,
 * which holding a lot resides in after a transfer — is the same under every
 * tax regime. Identification is not, so it is the only thing that varies, and
 * it lives here rather than in the walk.
 */
export type CostBasisMethod = CostBasisMethodDto;

/** The lot shape both methods consume. `CostBasisService.ComponentLot` is it. */
export interface PoolLot {
  qty: Decimal;
  cost: Decimal;
  date: Date;
  holdingId: string;
  stale?: boolean;
  unpriced?: boolean;
}

/**
 * Take `want` units out of `holdingId`'s lots, oldest acquisition first,
 * splitting the last lot proportionally. Returns what was taken; takes less
 * than asked when the pool runs out, which the caller reports as a shortfall.
 *
 * Lifted out of `CostBasisService.walkPool` unchanged. Selection is by
 * acquisition DATE and not by array position, because an inherited lot
 * re-enters the pool carrying an older date than the lots already in it
 * (SC-344).
 */
export function drawOldestFirst(lots: PoolLot[], holdingId: string, want: Decimal): PoolLot[] {
  const popped: PoolLot[] = [];
  let remaining = want;
  while (remaining.gt(0)) {
    let idx = -1;
    for (let i = 0; i < lots.length; i++) {
      const l = lots[i];
      if (!l || l.holdingId !== holdingId) continue;
      const best = idx === -1 ? undefined : lots[idx];
      if (!best || l.date < best.date) idx = i;
    }
    if (idx === -1) break;
    const lot = lots[idx];
    if (!lot) break;
    if (lot.qty.lte(remaining)) {
      popped.push(lot);
      remaining = remaining.minus(lot.qty);
      lots.splice(idx, 1);
    } else {
      const ratio = remaining.div(lot.qty);
      const partialCost = lot.cost.mul(ratio);
      popped.push({
        qty: remaining,
        cost: partialCost,
        date: lot.date,
        holdingId,
        stale: lot.stale,
        unpriced: lot.unpriced,
      });
      lot.qty = lot.qty.minus(remaining);
      lot.cost = lot.cost.minus(partialCost);
      remaining = new Decimal(0);
    }
  }
  return popped;
}

/**
 * Take `want` units out of `holdingId`'s lots at the pool's average cost —
 * the Section 104 holding of TCGA92/S104.
 *
 * Implemented as a pro-rata draw across every lot rather than as a running
 * `{qty, cost}` pair, and the two are arithmetically identical: taking
 * `want / total` of each lot's cost sums to `poolCost x want / poolQty`, which
 * IS the average-cost answer, and it leaves the remaining pool's average
 * unchanged. What the lot form buys is everything the ledger is made of — a
 * disposal still reports which acquisitions it consumed and when they were
 * made, so `DisposalLotMatch` keeps working and a reader can still see the
 * dates behind a figure. UK CGT has no holding-period distinction, so nothing
 * in the tax arithmetic depends on those dates; a person reading their own
 * ledger does.
 *
 * The last slice absorbs the rounding residual. At 28 significant digits the
 * residual is around 1e-25 of a unit, but it is not zero, and a walk that
 * returns marginally less than it was asked for emits a shortfall row priced
 * as pure gain (`recordDisposal`). Exactness here is what stops a rounding
 * artefact from rendering as an unexplained acquisition-less disposal.
 */
export function drawPooled(lots: PoolLot[], holdingId: string, want: Decimal): PoolLot[] {
  if (want.lte(0)) return [];
  const owned: number[] = [];
  let poolQty = new Decimal(0);
  let poolCost = new Decimal(0);
  for (let i = 0; i < lots.length; i++) {
    const l = lots[i];
    if (!l || l.holdingId !== holdingId) continue;
    owned.push(i);
    poolQty = poolQty.add(l.qty);
    poolCost = poolCost.add(l.cost);
  }
  if (owned.length === 0 || poolQty.lte(0)) return [];

  const take = Decimal.min(want, poolQty);
  if (take.gte(poolQty)) {
    // Whole pool: return the lots themselves rather than computing shares of
    // one, so "sold everything" costs exactly what everything cost.
    const drained = owned.map((i) => lots[i] as PoolLot);
    for (const i of [...owned].reverse()) lots.splice(i, 1);
    return drained;
  }

  const ratio = take.div(poolQty);
  const targetCost = poolCost.mul(ratio);
  const slices: PoolLot[] = [];
  let takenQty = new Decimal(0);
  let takenCost = new Decimal(0);
  for (let n = 0; n < owned.length; n++) {
    const lot = lots[owned[n] as number] as PoolLot;
    const last = n === owned.length - 1;
    const sliceQty = last ? take.minus(takenQty) : lot.qty.mul(ratio);
    const sliceCost = last ? targetCost.minus(takenCost) : lot.cost.mul(ratio);
    takenQty = takenQty.add(sliceQty);
    takenCost = takenCost.add(sliceCost);
    slices.push({
      qty: sliceQty,
      cost: sliceCost,
      date: lot.date,
      holdingId,
      stale: lot.stale,
      unpriced: lot.unpriced,
    });
    lot.qty = lot.qty.minus(sliceQty);
    lot.cost = lot.cost.minus(sliceCost);
  }
  // A pro-rata draw empties no lot before the others, so nothing is removed
  // here — except a lot that was empty on arrival, which would otherwise sit
  // in the pool forever contributing a zero share.
  for (const i of [...owned].reverse()) {
    const lot = lots[i] as PoolLot;
    if (lot.qty.lte(0)) lots.splice(i, 1);
  }
  return slices;
}

/** The draw this method uses for everything the identification rules do not claim. */
export function poolDrawFor(
  method: CostBasisMethod
): (lots: PoolLot[], holdingId: string, want: Decimal) => PoolLot[] {
  return method === 'uk_section_104' ? drawPooled : drawOldestFirst;
}

/**
 * The tax day an instant falls on.
 *
 * `Europe/London` and not UTC, deliberately. Both HMRC rules this file
 * implements are stated in calendar days, and the calendar a UK return is
 * filed against is London's — so a trade at 23:30 UTC on 30 June happened on
 * 1 July for the same-day rule, because British Summer Time was in force. UTC
 * would put it on the wrong side of a boundary for seven months of the year,
 * and only ever for trades in the last hour of the day, which is exactly the
 * shape of error nobody notices.
 */
const LONDON_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function taxDayKey(at: Date): string {
  return LONDON_DAY.format(at);
}

/** Whole days from `from`'s tax day to `to`'s, counted on the calendar. */
export function taxDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The window the bed-and-breakfast rule reaches over: the 30 days AFTER a
 * disposal, the disposal's own day excluded (that is the same-day rule's, and
 * it takes precedence).
 *
 * HMRC's own example fixes the far edge: a sale on 31 March matched an
 * acquisition on 28 April and did NOT match one on 1 May, which is day 31
 * (CRYPTO22253). CG51560 states the same boundary the other way round — a sale
 * on 28 February 2009 against a purchase on 31 March 2009 falls outside.
 */
export const BED_AND_BREAKFAST_DAYS = 30;

/** One acquisition the identification rules may claim, in ledger order. */
export interface PlanAcquisition {
  txId: string;
  holdingId: string;
  occurredAt: Date;
  qty: Decimal;
}

/** One disposal the identification rules apply to, in ledger order. */
export interface PlanDisposal {
  /** `${txId}#${portionIndex}` — an outflow answered as two things is two disposals. */
  key: string;
  holdingId: string;
  occurredAt: Date;
  qty: Decimal;
}

/** Units of one acquisition claimed by one disposal, outside the pool. */
export interface ForwardMatch {
  acquisitionTxId: string;
  qty: Decimal;
}

export interface Section104Plan {
  /** Disposal key → the acquisitions it is matched against, in matching order. */
  forward: ReadonlyMap<string, ForwardMatch[]>;
  /** Acquisition tx id → units claimed by rule 1 or 2, which never reach the pool. */
  reserved: ReadonlyMap<string, Decimal>;
}

export const EMPTY_SECTION_104_PLAN: Section104Plan = { forward: new Map(), reserved: new Map() };

/**
 * Which acquisitions each disposal is matched against under HMRC's
 * identification rules, decided for the whole ledger before the walk begins.
 *
 * **It has to be a pre-pass, because rule 2 matches forwards in time.** A
 * disposal on 5 August is identified with a purchase on 6 August, so no
 * sequential fold can answer it at the moment it reaches the disposal. What it
 * CAN do is decide the matching up front from quantities and dates alone —
 * neither rule looks at a price — and hand the walk a plan: these units of
 * that acquisition belong to this disposal, and never enter the pool.
 *
 * Two phases rather than one loop, and the order between them is the statute's:
 *
 * 1. **Same day (TCGA92/S105(1))** for every disposal, drawn PRO-RATA across
 *    that day's acquisitions. The section treats same-day acquisitions as a
 *    single transaction, so their blended cost is what a same-day disposal
 *    gets — not the first one in the list.
 * 2. **The following 30 days (TCGA92/S106A(5))** for whatever is left,
 *    disposals earliest-first and acquisitions earliest-first within each. Both
 *    orderings are HMRC's own (CRYPTO22253: a 31 March sale takes the whole of
 *    the 21 April purchase and 300 of the 28 April one, leaving the rest of 28
 *    April to the 20 April sale).
 *
 * Running phase 1 for ALL disposals before phase 2 for any is load-bearing. An
 * acquisition can be reachable by a same-day disposal and by an earlier
 * disposal's 30-day window at once, and same-day wins; a single pass in
 * disposal order would let the earlier disposal take it first.
 *
 * Everything unclaimed falls through to the pool, which is the walk's job.
 * Matching is per HOLDING — see `docs/features/cost-basis-methods.md` for what
 * that does and does not cover.
 */
export function planSection104Matches(
  acquisitions: readonly PlanAcquisition[],
  disposals: readonly PlanDisposal[]
): Section104Plan {
  if (acquisitions.length === 0 || disposals.length === 0) return EMPTY_SECTION_104_PLAN;

  const acqDay = new Map<string, string>();
  for (const a of acquisitions) acqDay.set(a.txId, taxDayKey(a.occurredAt));
  const left = new Map<string, Decimal>(acquisitions.map((a) => [a.txId, a.qty]));
  const forward = new Map<string, ForwardMatch[]>();
  const reserved = new Map<string, Decimal>();
  const unmatched = new Map<string, Decimal>(disposals.map((d) => [d.key, d.qty]));

  const claim = (disposalKey: string, acq: PlanAcquisition, qty: Decimal): void => {
    if (qty.lte(0)) return;
    const rows = forward.get(disposalKey);
    if (rows) rows.push({ acquisitionTxId: acq.txId, qty });
    else forward.set(disposalKey, [{ acquisitionTxId: acq.txId, qty }]);
    reserved.set(acq.txId, (reserved.get(acq.txId) ?? new Decimal(0)).add(qty));
    left.set(acq.txId, (left.get(acq.txId) as Decimal).minus(qty));
    unmatched.set(disposalKey, (unmatched.get(disposalKey) as Decimal).minus(qty));
  };

  // Phase 1 — same day, pro-rata across the day's acquisitions.
  for (const disposal of disposals) {
    const want = unmatched.get(disposal.key) as Decimal;
    if (want.lte(0)) continue;
    const day = taxDayKey(disposal.occurredAt);
    const bucket = acquisitions.filter(
      (a) =>
        a.holdingId === disposal.holdingId &&
        acqDay.get(a.txId) === day &&
        (left.get(a.txId) as Decimal).gt(0)
    );
    if (bucket.length === 0) continue;
    const available = bucket.reduce((s, a) => s.add(left.get(a.txId) as Decimal), new Decimal(0));
    const take = Decimal.min(want, available);
    const ratio = take.div(available);
    let claimed = new Decimal(0);
    for (let i = 0; i < bucket.length; i++) {
      const acq = bucket[i] as PlanAcquisition;
      const share =
        i === bucket.length - 1 ? take.minus(claimed) : (left.get(acq.txId) as Decimal).mul(ratio);
      claimed = claimed.add(share);
      claim(disposal.key, acq, share);
    }
  }

  // Phase 2 — the 30 days after, earliest acquisition first.
  for (const disposal of disposals) {
    let want = unmatched.get(disposal.key) as Decimal;
    if (want.lte(0)) continue;
    const day = taxDayKey(disposal.occurredAt);
    for (const acq of acquisitions) {
      if (want.lte(0)) break;
      if (acq.holdingId !== disposal.holdingId) continue;
      const remaining = left.get(acq.txId) as Decimal;
      if (remaining.lte(0)) continue;
      const gap = taxDaysBetween(day, acqDay.get(acq.txId) as string);
      if (gap <= 0 || gap > BED_AND_BREAKFAST_DAYS) continue;
      const share = Decimal.min(want, remaining);
      claim(disposal.key, acq, share);
      want = want.minus(share);
    }
  }

  return { forward, reserved };
}

export { DEFAULT_COST_BASIS_METHOD };
