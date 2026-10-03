import Decimal from 'decimal.js';

/**
 * A hand-entered balance edit, reduced to what supersession needs.
 *
 * `amount` is the NET the person entered — the flow row plus its carved-out
 * `:fee` row — because that is the figure they typed and the figure the
 * imported rows must add up to (SC-1468: Airwallex's +5,600.75 edit against an
 * imported 5,617.60 deposit and -16.85 fee).
 */
export interface ManualEditCandidate {
  readonly flowId: string;
  readonly rowIds: readonly string[];
  readonly amount: Decimal;
  readonly occurredAt: Date;
  readonly editedAt: Date;
  readonly answer: RowAnswer | null;
}

export interface ImportedCandidate {
  readonly id: string;
  readonly quantity: Decimal;
  readonly occurredAt: Date;
  readonly answer: RowAnswer | null;
}

/**
 * The owner's answer on a row, in the two parts that make two answers "the
 * same thing": what kind of answer it is, and where the money went. The
 * destination is a canonical string the caller derives (a counterpart holding
 * id, or a split's sorted destinations), so the comparison here is exact.
 */
export interface RowAnswer {
  readonly kind: string;
  readonly destination: string | null;
}

export type SupersessionVerdict =
  | {
      readonly status: 'supersede';
      readonly edit: ManualEditCandidate;
      readonly importedIds: readonly string[];
    }
  | {
      readonly status: 'answer-differs';
      readonly edit: ManualEditCandidate;
      readonly importedIds: readonly string[];
    };

const DAY_MS = 24 * 60 * 60 * 1000;
// Brute-force subset search is 2^n; a window of a day or two holds a handful
// of rows, and a wider one is no longer evidence that they describe one edit.
const MAX_WINDOW_ROWS = 12;

/**
 * Which hand-entered edits are now described by imported rows (SC-1468).
 *
 * An edit is matched when the imported rows inside
 * `[occurredAt - 1d, editedAt + 2d]` contain exactly ONE subset that adds up to
 * the edit's net amount, and no earlier edit has already claimed those rows.
 * Ambiguity matches nothing: two subsets that both fit say the rows do not
 * identify the movement.
 *
 * A matched edit is superseded only when no owner answer would be lost: the
 * edit is unanswered, or exactly one matched row carries an answer and it says
 * the same thing. Otherwise the verdict is `answer-differs` and the caller
 * leaves the edit in place, so it stays in Review for the owner.
 */
export function findSupersededEdits(
  edits: readonly ManualEditCandidate[],
  imported: readonly ImportedCandidate[]
): SupersessionVerdict[] {
  const claimed = new Set<string>();
  const verdicts: SupersessionVerdict[] = [];
  const ordered = [...edits].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  for (const edit of ordered) {
    const from = edit.occurredAt.getTime() - DAY_MS;
    const to = edit.editedAt.getTime() + 2 * DAY_MS;
    const window = imported.filter(
      (row) =>
        !claimed.has(row.id) && row.occurredAt.getTime() >= from && row.occurredAt.getTime() <= to
    );
    if (window.length === 0 || window.length > MAX_WINDOW_ROWS) continue;

    const subset = uniqueSubsetSummingTo(window, edit.amount);
    if (!subset) continue;
    for (const row of subset) claimed.add(row.id);

    const importedIds = subset.map((row) => row.id);
    verdicts.push({
      status: answersAgree(edit.answer, subset) ? 'supersede' : 'answer-differs',
      edit,
      importedIds,
    });
  }
  return verdicts;
}

function answersAgree(editAnswer: RowAnswer | null, rows: readonly ImportedCandidate[]): boolean {
  if (!editAnswer) return true;
  const answered = rows.filter((row) => row.answer);
  if (answered.length !== 1) return false;
  const other = answered[0]?.answer;
  return other?.kind === editAnswer.kind && other.destination === editAnswer.destination;
}

function uniqueSubsetSummingTo(
  rows: readonly ImportedCandidate[],
  target: Decimal
): ImportedCandidate[] | null {
  let found: ImportedCandidate[] | null = null;
  const total = 1 << rows.length;
  for (let mask = 1; mask < total; mask++) {
    let sum = new Decimal(0);
    for (let i = 0; i < rows.length; i++) {
      if (mask & (1 << i)) sum = sum.add(rows[i]?.quantity ?? 0);
    }
    if (!sum.eq(target)) continue;
    if (found) return null;
    found = rows.filter((_, i) => mask & (1 << i));
  }
  return found;
}
