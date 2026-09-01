import {
  answerIsOwedFor,
  type DisposalAnswerSourceDto,
  type DisposalLotMatchDto,
  type DisposalOutcomeDto,
  formatNumber,
  type ValuationBasisDto,
} from '@scani/shared';
import type { TFunction } from 'i18next';

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
  /** Whose answer the outcome rests on (SC-324). A property of the outflow,
   *  so every row in a group carries the same value. */
  answerSource: DisposalAnswerSourceDto;
  /** Which price produced the proceeds (SC-397). Also a property of the
   *  outflow — every lot in a group is a pro-rata share of one valuation —
   *  so the group takes the first row's and never disagrees with itself. */
  valuationBasis: ValuationBasisDto | null;
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
      answerSource: row.answerSource,
      valuationBasis: row.valuationBasis,
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
export function portionLabel(group: DisposalGroup, t: TFunction): string | null {
  if (group.portionCount <= 1) return null;
  return t('v3.realizedLedger.portion', {
    index: group.portionIndex + 1,
    total: group.portionCount,
    noun: t(disposalNounKey(group.kind)),
  });
}

/** The event as a noun, for a sentence `disposalVerb` cannot fit into. */
function disposalNounKey(kind: string): string {
  switch (kind) {
    case 'sell':
      return 'v3.realizedLedger.noun.sale';
    case 'swap_out':
      return 'v3.realizedLedger.noun.swap';
    case 'withdraw':
      return 'v3.realizedLedger.noun.withdrawal';
    case 'transfer_out':
      return 'v3.realizedLedger.noun.transfer';
    default:
      return 'v3.realizedLedger.noun.disposal';
  }
}

function addStrings(a: string, b: string): string {
  return String(Number(a) + Number(b));
}

/** What the ledger calls the event, from the row's raw `kind`. Deliberately not
 *  "sold" for a withdrawal — see `DisposalLotMatch.kind`. */
export function disposalVerb(kind: string, t: TFunction): string {
  switch (kind) {
    case 'sell':
      return t('v3.realizedLedger.verb.sold');
    case 'swap_out':
      return t('v3.realizedLedger.verb.swapped');
    case 'withdraw':
      return t('v3.realizedLedger.verb.withdrew');
    case 'transfer_out':
      return t('v3.realizedLedger.verb.transferredOut');
    default:
      return t('v3.realizedLedger.verb.disposed');
  }
}

/**
 * Why this event did or did not move the realized figure.
 *
 * Written as a consequence rather than a state, because a reader who opened
 * this to explain a number does not want a taxonomy. A `realized` row answered
 * by a person has no note — the gain beside it is the whole answer, and a
 * sentence saying so would be noise on the majority of rows.
 *
 * **The two outcomes that come from an answer take the answer's provenance**
 * (SC-324). `retained` said *"You said this never left your control"* on every
 * row, and `realized` said nothing at all, on both the rows a person answered
 * and the 560 in production where an `UPDATE` wrote `left_control` and no
 * record of who decided exists. Those are the rows that book money — -39,349.52
 * USD of a -33,026.05 USD realized total on 2026-08-17 — so this is the one
 * surface where the difference is worth a sentence.
 *
 * **`kind` is here because provenance is only a question for the kinds the
 * review queue asks about** (SC-402). A `swap_out` books its gain on its kind
 * alone, so "there is no record of anyone answering it" is not a caveat about
 * it — it is a sentence about a question nobody put. The server no longer
 * sends `unattributed` on such a row; this refuses to render it if one ever
 * arrives, because the false sentence exists on the screen and a guard one
 * layer back cannot fail here.
 */
export function outcomeNote(
  kind: string,
  outcome: DisposalOutcomeDto,
  answerSource: DisposalAnswerSourceDto,
  t: TFunction
): string | null {
  const unattributed = answerIsOwedFor(kind) && answerSource === 'unattributed';
  switch (outcome) {
    case 'realized':
      return unattributed ? t('v3.realizedLedger.outcome.realizedUnattributed') : null;
    case 'unpriced':
      return t('v3.realizedLedger.outcome.unpriced');
    case 'unreviewed':
      return t('v3.realizedLedger.outcome.unreviewed');
    case 'retained':
      return t(
        unattributed
          ? 'v3.realizedLedger.outcome.retainedUnattributed'
          : 'v3.realizedLedger.outcome.retained'
      );
    case 'awaiting_pair':
      return t('v3.realizedLedger.outcome.awaitingPair');
    case 'fee':
      // Unconditional, and the one outcome with no `unattributed` variant:
      // nothing here rests on who answered, because no gain was booked either
      // way and the sentence would be a caveat about a figure the row does not
      // carry (SC-888).
      return t('v3.realizedLedger.outcome.fee');
  }
}

/**
 * Kinds whose value is denominated in something other than the token that
 * moved. Only these can fall back (SC-397) — everything else is *always*
 * valued from the token in hand, so saying so would be noise on every row.
 */
const COUNTER_PRICED_KINDS = new Set(['swap_in', 'swap_out']);

/**
 * "This swap was valued from the token that left, because what came back has
 * no price" — or null, which is almost every row.
 *
 * A swap carries the rate it executed at, taken off its other leg, and that
 * rate is exact. When the asset on the other side has no price history the
 * rate cannot be converted to the reader's currency, and the leg is valued
 * from the token in hand instead.
 *
 * **This note is the whole of SC-397's visible half.** Before it, that row
 * booked 0.00 and said nothing — and 0.00 is also what a disposal that
 * genuinely earned nothing books, so the two were the same thing on screen.
 * Valuing it properly fixes the arithmetic and would have replaced a silent
 * zero with a silent estimate; this is what stops it doing that.
 */
export function valuationNote(
  kind: string,
  basis: ValuationBasisDto | null,
  t: TFunction
): string | null {
  if (basis !== 'held_token' || !COUNTER_PRICED_KINDS.has(kind)) return null;
  return t('v3.realizedLedger.valuation.heldTokenFallback');
}

/**
 * The "Answer not recorded" chip, or null — the scannable half of
 * `outcomeNote`'s provenance sentence (SC-324).
 *
 * Lifted out of the component and given the same kind gate as the sentence it
 * summarises (SC-402). It was a ternary inline in the JSX reading
 * `answerSource === 'unattributed'`, which meant the badge and the paragraph
 * under it tested two different conditions written in two places — and a chip
 * saying "Answer not recorded" above a paragraph saying nothing is the same
 * false claim in fewer words.
 */
export function answerLabel(
  kind: string,
  answerSource: DisposalAnswerSourceDto,
  t: TFunction
): string | null {
  if (!answerIsOwedFor(kind) || answerSource !== 'unattributed') return null;
  return t('v3.realizedLedger.answer.unattributedLabel');
}

/** The chip that carries `valuationNote` up into the scannable row. Same
 *  reasoning as the unattributed badge (SC-324): a caveat that exists only as
 *  prose in a paragraph the reader is skipping is not on the screen. */
export function valuationLabel(
  kind: string,
  basis: ValuationBasisDto | null,
  t: TFunction
): string | null {
  if (basis !== 'held_token' || !COUNTER_PRICED_KINDS.has(kind)) return null;
  return t('v3.realizedLedger.valuation.estimatedLabel');
}

/** The caveat a non-`known` row carries (SC-149). `known` gets none. */
export function basisQualityNote(
  quality: DisposalLotMatchDto['basisQuality'],
  t: TFunction
): string | null {
  switch (quality) {
    case 'known':
      return null;
    case 'partial':
      return t('v3.realizedLedger.basis.partialNote');
    case 'unknown':
      return t('v3.realizedLedger.basis.unknownNote');
  }
}

/** The one-word chip beside a lot whose basis is not settled. */
export function basisQualityLabel(
  quality: DisposalLotMatchDto['basisQuality'],
  t: TFunction
): string | null {
  return quality === 'known'
    ? null
    : quality === 'partial'
      ? t('v3.realizedLedger.basis.partialLabel')
      : t('v3.realizedLedger.basis.unknownLabel');
}

/** How long the lot was held, in the units a person would say it in. */
export function holdingPeriodLabel(days: number | null, t: TFunction): string | null {
  if (days === null) return null;
  if (days < 1) return t('v3.realizedLedger.held.sameDay');
  if (days < 60) return t('v3.realizedLedger.held.days', { count: days });
  if (days < 730) return t('v3.realizedLedger.held.months', { count: Math.round(days / 30) });
  // One decimal place, through the reader's number locale rather than
  // `toFixed`: `toFixed` is fixed to a full stop, so a Russian reader saw
  // "2.0 года" beside every other figure on the page rendered "1 234,50"
  // (SC-201). The value stays a STRING so i18next cannot pluralise on it —
  // that is deliberate, because a fractional year takes one form in every
  // language checked, and `{{years}}` is what a language that needs more
  // gets to work with.
  return t('v3.realizedLedger.held.years', {
    years: formatNumber(days / 365, { decimals: 1 }),
  });
}
