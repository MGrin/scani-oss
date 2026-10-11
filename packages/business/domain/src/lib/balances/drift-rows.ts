import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { residualSteps } from '../../engine/balance-at';
import type { HoldingEvidence } from '../../engine/types';

/**
 * A balance change no ledger row explains, as rows the money side can read
 * (SC-1470).
 *
 * mgrin, 2026-10-01, deciding against SC-501's rule knowingly: an unexplained
 * change is money in or out, never gain. Unanswered and `unknown` gaps become
 * `drift_in` / `drift_out`, which `flowRoleOf` classifies as external; a gap
 * the owner answered `growth` becomes `drift_growth`, which is return, because
 * he said it was. `flow` and `correction` answers write their own ledger rows,
 * so whatever drift survives them is unexplained again and treated as above.
 *
 * The rows are the engine's value less the ledger the money side reads, booked
 * where that difference changes (SC-1637). So ledger plus drift equals the
 * value series at every instant: a gap's change lands whole where the engine
 * takes it, at the window its later anchor opens, never cut at the day ends
 * inside the gap; a reading the engine does not anchor on moves nothing; and a
 * ledger row the engine leaves out is undone by a row of drift beside it.
 *
 * These rows are never written. They are for readers of money (flows, cost
 * basis, income) only: the balance walk already carries the same drift, and
 * handing it these too would count it twice.
 */
export const DRIFT_IN_KIND = 'drift_in';
export const DRIFT_OUT_KIND = 'drift_out';
export const DRIFT_GROWTH_KIND = 'drift_growth';

const GROWTH_ANSWER = 'growth';

export interface DriftRow {
  id: string;
  holdingId: string;
  tokenId: string;
  kind: typeof DRIFT_IN_KIND | typeof DRIFT_OUT_KIND | typeof DRIFT_GROWTH_KIND;
  quantity: string;
  occurredAt: Date;
  /** The row that opens the holding, as distinct from a gap's drift. */
  opening?: true;
}

interface LedgerRow {
  occurredAt: Date;
  quantity: string;
}

/**
 * The opening counts as well as the gaps (SC-1470). The engine values a
 * holding from `startsAt`, and what it held then less what the ledger explains
 * by then is money in, booked just before `startsAt` and never before its own
 * day: flows are counted by day, so the money side sees it on the day the value
 * series first counts the holding, and the cost walk meets it before any row
 * that draws on it. A holding whose ledger explains its value opens with nothing.
 *
 * `gapReviewOf` is each observation's gap answer, by id: a step at the window
 * of an anchor answered `growth` is return.
 *
 * `pricedFrom` is the token's first stored price. An opening before it would
 * cost nothing, and the whole position would read as gain (SC-1638), so the
 * opening waits for it and books what is unexplained then. Before that day
 * nothing can value the holding on either side.
 */
export function driftRows(
  holding: { holdingId: string; tokenId: string },
  evidence: HoldingEvidence,
  ledger: ReadonlyArray<LedgerRow>,
  gapReviewOf: ReadonlyMap<string, string | null>,
  pricedFrom: Date | null = null
): DriftRow[] {
  const rows: DriftRow[] = [];
  const push = (kind: DriftRow['kind'], quantity: Decimal, at: Date, opening = false) =>
    rows.push({
      id: `drift:${holding.holdingId}:${rows.length}`,
      holdingId: holding.holdingId,
      tokenId: holding.tokenId,
      kind,
      quantity: quantity.toString(),
      occurredAt: at,
      ...(opening ? { opening: true as const } : {}),
    });

  const start = evidence.startsAt.getTime();
  const open = Math.max(start, pricedFrom?.getTime() ?? start);
  const steps = residualSteps(evidence).map((step) => ({ ...step, t: step.at.getTime() }));
  const byTime = (rows: ReadonlyArray<{ t: number; q: string }>) =>
    [...rows].sort((a, b) => a.t - b.t);
  const entries = byTime(evidence.entries.map((e) => ({ t: e.at.getTime(), q: e.quantity })));
  const money = byTime(ledger.map((r) => ({ t: r.occurredAt.getTime(), q: r.quantity })));
  const instants = [
    ...new Set([
      start,
      open,
      ...steps.map((s) => s.t),
      ...entries.map((e) => e.t),
      ...money.map((m) => m.t),
    ]),
  ].sort((a, b) => a - b);

  // One sweep: each total moves forward with the instants, never re-summed.
  let entryTotal = new Decimal(0);
  let moneyTotal = new Decimal(0);
  let e = 0;
  let m = 0;
  let k = -1;
  let previous = new Decimal(0);
  for (const t of instants) {
    for (; e < entries.length && (entries[e] as { t: number }).t <= t; e += 1) {
      entryTotal = entryTotal.add((entries[e] as { q: string }).q);
    }
    for (; m < money.length && (money[m] as { t: number }).t <= t; m += 1) {
      moneyTotal = moneyTotal.add((money[m] as { q: string }).q);
    }
    while (k + 1 < steps.length && (steps[k + 1] as { t: number }).t <= t) k += 1;
    // A stored row before `startsAt` (an opening or a correction the engine
    // leaves out) is explained by the opening, not undone and re-bought.
    if (t < open) continue;
    const step = steps[k];
    const value = step === undefined ? new Decimal(0) : step.residual.add(entryTotal);
    const unexplained = value.sub(moneyTotal);
    const drift = unexplained.sub(previous);
    previous = unexplained;
    if (drift.isZero()) continue;
    if (t === open) {
      const earliest = Math.min(start, money[0]?.t ?? start);
      const at =
        open > start ? open : Math.max(earliest - 1, Math.floor(earliest / DAY_MS) * DAY_MS);
      push(drift.isNegative() ? DRIFT_OUT_KIND : DRIFT_IN_KIND, drift, new Date(at), true);
      continue;
    }
    const opens = step !== undefined && step.t === t ? step.anchorId : null;
    const growth = opens !== null && gapReviewOf.get(opens) === GROWTH_ANSWER;
    push(
      growth ? DRIFT_GROWTH_KIND : drift.isNegative() ? DRIFT_OUT_KIND : DRIFT_IN_KIND,
      drift,
      new Date(t)
    );
  }
  return rows;
}

/**
 * A positive opening, in ledger shape. It is what the holding held before its
 * first record, so a walk meets it before any row sharing its instant: a first
 * record at 00:00Z puts the opening on that instant, and the ledger order would
 * otherwise walk a same-instant sale first, from an empty pool (A5).
 */
export function isOpeningArrival(
  row: Pick<HoldingTransaction, 'source' | 'kind' | 'sourceMetadata'>
): boolean {
  return (
    row.source === 'drift' &&
    row.kind === DRIFT_IN_KIND &&
    (row.sourceMetadata as { opening?: unknown } | null)?.opening === true
  );
}

/** The rows in the ledger's own shape, for readers that walk ledger rows. */
export function asLedgerRows(rows: ReadonlyArray<DriftRow>, userId: string): HoldingTransaction[] {
  return rows.map(
    (row) =>
      ({
        id: row.id,
        userId,
        holdingId: row.holdingId,
        tokenId: row.tokenId,
        kind: row.kind,
        quantity: row.quantity,
        priceNative: null,
        priceNativeTokenId: null,
        counterTokenId: null,
        counterQuantity: null,
        counterPriceNative: null,
        counterPriceNativeTokenId: null,
        feeQuantity: null,
        feeTokenId: null,
        occurredAt: row.occurredAt,
        externalId: row.id,
        swapGroupId: null,
        transferGroupId: null,
        transferReview: null,
        transferReviewSplit: null,
        transferReviewedAt: null,
        transferReviewSource: null,
        transferReviewRuleId: null,
        settlesTransactionId: null,
        counterparty: null,
        description: null,
        source: 'drift',
        sourceMetadata: row.opening ? { opening: true } : {},
        rawPayload: null,
        createdAt: row.occurredAt,
        updatedAt: row.occurredAt,
      }) as HoldingTransaction
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
