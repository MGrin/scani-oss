import type { DisposalLotMatchDto, DisposalOutcomeDto } from '@scani/shared';

/**
 * Copy and grouping for the realized-PnL ledger (SC-152).
 *
 * The API returns one row per (outflow, lot) pair, which is the right shape to
 * compute with and the wrong one to read: a sale that consumed three lots
 * arrives as three rows that look like three sales. The reader's question is
 * "why did this figure change", and the answer is one event with several
 * sources under it — so the list is grouped back to the transaction here,
 * where it can be tested without a DOM.
 *
 * Nothing in this file may take a tax framing. See
 * `docs/technical/2026-08-14_why-no-tax-statement.md`.
 */

export interface DisposalGroup {
  transactionId: string;
  kind: string;
  disposedAt: string;
  outcome: DisposalOutcomeDto;
  /** Unsigned, summed across the group's lots. */
  quantity: string;
  /** Null wherever nothing was realized — the group's own reason is `outcome`. */
  gain: string | null;
  /** True when any lot in the group rests on something less than settled. */
  qualified: boolean;
  /** Which share of a divided outflow this is, and of how many (SC-181).
   *  `0` / `1` on every whole answer. */
  portionIndex: number;
  portionCount: number;
  lots: DisposalLotMatchDto[];
}

/**
 * Group the flat rows back into the events a person recognises, preserving the
 * order the API sent (newest disposal first).
 *
 * **Keyed on transaction AND portion** (SC-181). One outflow can be answered as
 * several things at once — 3,500 moved somewhere untracked, 500 genuinely left
 * — and the two shares have different outcomes, different proceeds and
 * different gains. Grouping on `transactionId` alone would fold them into one
 * row carrying one `outcome` that is true of neither half, and a ledger that
 * hides the division has stopped explaining, which is the whole of its job.
 *
 * Sums are done in `Number` rather than `Decimal`, and only for display. Every
 * figure a reader compares against another figure — each lot's gain, the total
 * — comes from the server as a Decimal string and is rendered from it. What is
 * summed here is one group's own lots, to label the group, and a rounding
 * difference in the last place of a heading is not a claim anyone checks.
 */
export function groupDisposals(rows: readonly DisposalLotMatchDto[]): DisposalGroup[] {
  const groups: DisposalGroup[] = [];
  const byId = new Map<string, DisposalGroup>();

  for (const row of rows) {
    const key = `${row.transactionId}#${row.portionIndex}`;
    const existing = byId.get(key);
    if (existing) {
      existing.lots.push(row);
      existing.quantity = addStrings(existing.quantity, row.quantity);
      existing.gain =
        row.gain === null ? existing.gain : addStrings(existing.gain ?? '0', row.gain);
      existing.qualified = existing.qualified || row.basisQuality !== 'known';
      continue;
    }
    const group: DisposalGroup = {
      transactionId: row.transactionId,
      kind: row.kind,
      disposedAt: row.disposedAt,
      outcome: row.outcome,
      quantity: row.quantity,
      gain: row.gain,
      qualified: row.basisQuality !== 'known',
      portionIndex: row.portionIndex,
      portionCount: row.portionCount,
      lots: [row],
    };
    byId.set(key, group);
    groups.push(group);
  }

  return groups;
}

/**
 * "Part 1 of 2 of this withdrawal", or null when the outflow was answered
 * whole.
 *
 * Says *of this withdrawal* rather than naming the transaction, because the
 * two shares are rendered adjacently and in order — the reader can see what
 * they are parts of. What they cannot see without this line is that the two
 * rows above and below each other are one event, and would otherwise read as
 * two separate withdrawals on the same day.
 */
export function portionLabel(group: DisposalGroup): string | null {
  if (group.portionCount <= 1) return null;
  return `Part ${group.portionIndex + 1} of ${group.portionCount} of one ${disposalNoun(group.kind)}`;
}

/** The event as a noun, for a sentence `disposalVerb` cannot fit into. */
function disposalNoun(kind: string): string {
  switch (kind) {
    case 'sell':
      return 'sale';
    case 'swap_out':
      return 'swap';
    case 'withdraw':
      return 'withdrawal';
    case 'transfer_out':
      return 'transfer';
    default:
      return 'disposal';
  }
}

function addStrings(a: string, b: string): string {
  return String(Number(a) + Number(b));
}

/** What the ledger calls the event, from the row's raw `kind`. Deliberately not
 *  "sold" for a withdrawal — see `DisposalLotMatch.kind`. */
export function disposalVerb(kind: string): string {
  switch (kind) {
    case 'sell':
      return 'Sold';
    case 'swap_out':
      return 'Swapped';
    case 'withdraw':
      return 'Withdrew';
    case 'transfer_out':
      return 'Transferred out';
    default:
      return 'Disposed';
  }
}

/**
 * Why this event did or did not move the realized figure.
 *
 * Written as a consequence rather than a state, because a reader who opened
 * this to explain a number does not want a taxonomy. `realized` has no note —
 * the gain beside it is the whole answer, and a sentence saying so would be
 * noise on the majority of rows.
 */
export function outcomeNote(outcome: DisposalOutcomeDto): string | null {
  switch (outcome) {
    case 'realized':
      return null;
    case 'unpriced':
      return 'No price could be found for this, so no gain was booked. The cost is still shown.';
    case 'unreviewed':
      return 'Waiting on your answer, so no gain was booked either way.';
    case 'retained':
      return 'You said this never left your control, so nothing was realized.';
    case 'awaiting_pair':
      return 'Only one side of this move was imported, so no gain was booked.';
  }
}

/** The caveat a non-`known` row carries (SC-149). `known` gets none. */
export function basisQualityNote(quality: DisposalLotMatchDto['basisQuality']): string | null {
  switch (quality) {
    case 'known':
      return null;
    case 'partial':
      return 'Based on history we know is incomplete or a price outside our freshness window.';
    case 'unknown':
      return 'We have no record of acquiring this, so the whole amount shows as gain. Most often that is an import that could not fetch far enough back.';
  }
}

/** The one-word chip beside a lot whose basis is not settled. */
export function basisQualityLabel(quality: DisposalLotMatchDto['basisQuality']): string | null {
  return quality === 'known'
    ? null
    : quality === 'partial'
      ? 'Partial basis'
      : 'No basis on record';
}

/** How long the lot was held, in the units a person would say it in. */
export function holdingPeriodLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days < 1) return 'same day';
  if (days < 60) return `${days} days`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}
