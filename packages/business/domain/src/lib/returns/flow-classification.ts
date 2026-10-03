import { DRIFT_GROWTH_KIND } from '../balances/drift-rows';
/**
 * Which ledger rows are CONTRIBUTIONS and which are PERFORMANCE (SC-457).
 *
 * This one table decides whether a portfolio "went up". Get it wrong in one
 * direction and every deposit reads as a gain; wrong in the other and every
 * staking reward is written off as the owner's own money.
 *
 * ## The rule it implements, and why it needs no pairing lookup
 *
 * The value series this is weighed against — `portfolio_value_daily`,
 * scope_kind `'holding'` — is RECONSTRUCTED FROM THIS SAME LEDGER:
 * `BalanceAtTimeService` walks signed `quantity` forward from an observation
 * anchor. So a transaction row on an in-scope holding has already moved that
 * scope's value by its own amount, and the only question left is whether that
 * movement was earned.
 *
 * That makes the two-sided cases fall out for free. A swap of BTC for ETH
 * inside the portfolio writes a `swap_out` on one holding and a `swap_in` on
 * the other; both are classified `external`, they carry opposite signs and
 * equal base value, and they CANCEL in the sum. A transfer between two
 * tracked accounts does the same. Only when one leg's holding is outside the
 * scope — a different vault, a hidden holding, an account not in the group —
 * does a net flow survive, which is exactly when value genuinely crossed the
 * boundary. So there is deliberately no `transfer_group_id` / `swap_group_id`
 * lookup here: the arithmetic already knows, and a second mechanism that
 * could disagree with it is a bug waiting for a bridge with a two-day delay.
 *
 * ## The two kinds of movement that are NOT contributions
 *
 * `reward`, `interest` and `airdrop` are value the portfolio PRODUCED. Booking
 * them as contributions would zero out staking yield — the return would read
 * 0% on a position doing nothing but earn.
 *
 * `fee` is value the portfolio CONSUMED. Booking it as a withdrawal would hide
 * costs from the return figure, which is the number costs are supposed to show
 * up in.
 *
 * ## `opening_balance` is external, and that is not obvious
 *
 * `OpeningBalanceReconciliationService` synthesizes these when the ledger and
 * an observed balance disagree — "you already held this much when we started
 * looking". Treating it as performance would show the position appearing out
 * of nothing, i.e. an infinite return on its first day. It is the position's
 * opening funding, so it is a contribution.
 *
 * ## `unknown` is external ON PURPOSE
 *
 * A balance movement nobody could classify is attributed to the owner's
 * pocket, not to skill. The error then runs toward understating the return,
 * which is the direction a performance figure should fail in — SC-149 is the
 * record of what happens when an unknown quietly becomes a gain.
 *
 * ## `correction` is NEITHER, and that is why there is a third role (SC-510)
 *
 * A `correction` row says the previously recorded balance was WRONG. Nothing
 * moved and nothing was earned — the record is being restated. Both of the
 * roles above are wrong for it, in different ways:
 *
 * * as `return`, a typo fixed upward prints as a gain;
 * * as `external`, it prints as money the owner paid in, which inflates every
 *   contribution total and every XIRR the ledger feeds.
 *
 * The second is the subtler one and it is why "just call it a flow" does not
 * work. TWR happens to survive it — subtracting the restatement from the
 * closing value gives that sub-period a return of zero, which is right — but
 * XIRR does not: it books a cash payment that no one made, at a date, and
 * discounts everything else against it.
 *
 * So `restatement` is subtracted from the value series like a flow, and
 * excluded from the investor's cashflows entirely. It is a correction to the
 * MEASUREMENT, not an event in the portfolio.
 *
 * ## `settle_in` / `settle_out` are external, named rather than defaulted (SC-1453)
 *
 * A settlement is the cash side of a single-row trade, written on the cash
 * holding. It must take the SAME role as the trade, because the two cancel only
 * as a pair of `external` rows with opposite signs and equal value: a buy is
 * money into the stock and its settlement the same money out of the cash, so
 * with both holdings in scope the trade is not a contribution, and with only
 * one it is exactly the value that crossed. They are named here because the
 * denylist default is a statement about kinds nobody has thought about, and a
 * later change to that default must not move these without someone deciding
 * to. The commission is a separate `fee` row, so the cost stays in the return.
 */

/** What a ledger row's value movement means for a return figure. */
export type FlowRole =
  /** Crossed the boundary — a contribution or a withdrawal. Not return. */
  | 'external'
  /** Produced or consumed by the portfolio itself. This IS the return. */
  | 'return'
  /**
   * The record was wrong and is being restated. Nothing moved and nothing was
   * earned, so it is neither the return nor a cashflow — see the note above.
   */
  | 'restatement';

const RETURN_KINDS: ReadonlySet<string> = new Set([
  'reward',
  'interest',
  'airdrop',
  'fee',
  // SC-1461: a futures loss is the investment losing money, not a withdrawal.
  'realized_pnl',
  // SC-1470: an unexplained balance change the owner answered `growth`. Every
  // other unexplained change is `drift_in` / `drift_out`, which the denylist
  // below already makes external (mgrin, 2026-10-01).
  DRIFT_GROWTH_KIND,
]);

/**
 * Restatements. One member today: `correction`, written only by
 * `ManualBalanceEditService` when the owner says a balance edit was fixing a
 * figure rather than recording money moving.
 *
 * An ALLOWLIST, unlike `flowRoleOf`'s denylist below, and for the same
 * reasoning read the other way round. The denylist is safe for `external`
 * because an unrecognised kind understates the return, which is the direction
 * a performance figure should fail in. Falling into `restatement` by accident
 * would remove a row from BOTH the return and the cashflows — value that
 * simply vanishes from every figure — so nothing may land here without being
 * named.
 */
const RESTATEMENT_KINDS: ReadonlySet<string> = new Set(['correction']);

const SETTLEMENT_KINDS: ReadonlySet<string> = new Set(['settle_in', 'settle_out']);

/**
 * Everything not named as performance is a contribution.
 *
 * Deliberately a denylist rather than an allowlist. `holding_transactions.kind`
 * is documented as open — "new ingesters may introduce new kinds without
 * requiring a schema migration. Readers should tolerate unknown kinds" — and
 * an allowlist would silently classify a `rebase` or a `slash` as return the
 * day it first appears. The denylist classifies it as a contribution instead,
 * which understates rather than inflates.
 */
export function flowRoleOf(kind: string): FlowRole {
  if (RESTATEMENT_KINDS.has(kind)) return 'restatement';
  if (SETTLEMENT_KINDS.has(kind)) return 'external';
  return RETURN_KINDS.has(kind) ? 'return' : 'external';
}

/**
 * A row's role, which differs from its kind's in one place (SC-1470): a `fee`
 * row settling a trade on ANOTHER holding is that trade's commission leaving
 * the cash. The trade's own row carries the same commission into the cost it
 * books, so as `return` it was counted twice. It is the trade's cash leg, so
 * it is `external`, like `settle_out`.
 *
 * A fee settling a trade on its OWN holding stays `return`: nothing else
 * absorbs it. That is an FX conversion's commission taken from the currency
 * it bought (SC-1464). `sameHoldingRowIds` is every row id on the fee's
 * holding the caller has; the trade is on the same holding when it is there.
 */
export function flowRoleOfRow(
  row: { kind: string; settlesTransactionId?: string | null },
  sameHoldingRowIds: ReadonlySet<string>
): FlowRole {
  if (
    row.kind === 'fee' &&
    row.settlesTransactionId &&
    !sameHoldingRowIds.has(row.settlesTransactionId)
  )
    return 'external';
  return flowRoleOf(row.kind);
}

/** Row ids grouped by holding, for `flowRoleOfRow`. */
export function rowIdsByHolding(
  rows: Iterable<{ id: string; holdingId: string }>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = out.get(row.holdingId) ?? new Set<string>();
    ids.add(row.id);
    out.set(row.holdingId, ids);
  }
  return out;
}

/**
 * Whether a trade's commission belongs in its flow: when it is paid in a
 * token other than the one the trade's holding holds, a fee row on that other
 * holding pays it, and the trade booked it into its cost (SC-1470).
 */
export function commissionCrossesInto(
  trade: { feeTokenId: string | null },
  heldTokenId: string | null
): boolean {
  return Boolean(trade.feeTokenId) && trade.feeTokenId !== heldTokenId;
}
