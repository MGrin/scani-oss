import type { PendingTransferReview, TransferReviewDecision } from '@scani/shared';
import { formatNumber, quantityDecimals } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Check } from 'lucide-react';
import {
  allocationHint,
  allocationOf,
  DECISION_LABELS,
  remainderFor,
  type SplitDraftRow,
} from '../../lib/transfer-review';

/**
 * The amounts, one per outcome (SC-181).
 *
 * The reported case, verbatim: *"3500 moved to my untracked account and 500
 * left them. I want to be able to edit the numbers to track vs not track
 * here."* Every SC-150 answer is about the whole transaction, so answering a
 * 4,000 withdrawal meant choosing which direction to be wrong in — `left my
 * portfolio` overstates the gain by 3,500, `moved somewhere untracked`
 * understates it by 500.
 *
 * Four decisions this shape makes, all of them load-bearing:
 *
 * - **All three outcomes are always on screen, and a blank is an exclusion.**
 *   No add-a-part button, no outcome picker per row, no way to enter the same
 *   outcome twice. The editor's whole state is three strings.
 * - **Nothing is pre-filled.** Dividing 4,000 as 3,500/500 is a fact only the
 *   reader has; a default would be the queue guessing, which is the defect
 *   SC-150 refused when it declined to auto-pair a near-miss. What the editor
 *   *does* offer is the remainder as a tap — arithmetic on a number the reader
 *   typed is not a guess, and it is the difference between one number entered
 *   by hand and two on a phone keyboard.
 * - **The running remainder is always visible.** "500 USDT still to account
 *   for" is the sentence that makes an exact sum reachable; "the parts must
 *   add up" is the sentence that makes it a puzzle.
 * - **`Same money` needs its deposit first.** Its field stays disabled until a
 *   candidate is selected above, because a paired part with no partner is not
 *   a smaller version of a valid answer — it is an unwritable one.
 */

interface TransferSplitEditorProps {
  item: PendingTransferReview;
  rows: SplitDraftRow[];
  onChange: (rows: SplitDraftRow[]) => void;
  /** Whether a candidate deposit has been picked, which `Same money` needs. */
  hasMatch: boolean;
}

export function TransferSplitEditor({ item, rows, onChange, hasMatch }: TransferSplitEditorProps) {
  const allocation = allocationOf(rows, item.quantity);
  const hint = allocationHint(allocation, item);
  // A ceiling, never a floor: the parts of a whole number can carry decimals
  // the total does not, so a scale taken from the transfer's own precision
  // would make its own remainder untypeable.
  const decimalScale = Math.max(8, decimalsIn(item.quantity));

  const setAmount = (index: number, amount: string) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, amount } : row)));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const disabled = row.decision === 'paired' && !hasMatch;
          const rest = remainderFor(rows, index, item.quantity);
          return (
            <div key={row.decision} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label
                  className="min-w-0 flex-1 text-body"
                  htmlFor={`split-${item.transactionId}-${row.decision}`}
                >
                  {DECISION_LABELS[row.decision].trigger}
                </label>
                <AmountInput
                  id={`split-${item.transactionId}-${row.decision}`}
                  value={row.amount}
                  onValueChange={(value) => setAmount(index, value)}
                  decimalScale={decimalScale}
                  disabled={disabled}
                  placeholder="0"
                  // 44px tall and right-aligned, so three amounts read as a
                  // column that can be added up by eye.
                  className="h-11 w-28 text-right"
                  wrapperClassName="shrink-0"
                  aria-label={`${DECISION_LABELS[row.decision].trigger} — amount in ${item.tokenSymbol}`}
                />
              </div>
              <div className="flex min-h-5 items-center justify-end gap-2">
                {disabled ? (
                  <span className="text-caption text-muted-foreground">
                    Pick the deposit above first
                  </span>
                ) : rest && rest !== row.amount ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-caption"
                    onClick={() => setAmount(index, rest)}
                  >
                    {`Take the rest — ${qtyLabel(rest)} ${item.tokenSymbol}`}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
        <span className="text-caption text-muted-foreground">
          {`Transfer was ${qtyLabel(item.quantity)} ${item.tokenSymbol}`}
        </span>
        {hint === null ? (
          <span className="flex items-center gap-1 text-caption text-foreground">
            <Check className="size-3" aria-hidden="true" />
            Adds up
          </span>
        ) : (
          <span className="text-caption text-muted-foreground">{hint}</span>
        )}
      </div>
    </div>
  );
}

/** The three rows, empty — the state the editor opens in. */
export function emptySplitRows(matchTransactionId: string | null): SplitDraftRow[] {
  const decisions: TransferReviewDecision[] = ['paired', 'left_control', 'untracked'];
  return decisions.map((decision) => ({ decision, amount: '', matchTransactionId }));
}

function qtyLabel(value: string): string {
  return formatNumber(value, { decimals: quantityDecimals(value) });
}

function decimalsIn(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}
