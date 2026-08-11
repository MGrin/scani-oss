import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { trpc } from '@/lib/trpc';

interface OccurrenceActionsProps {
  occurrenceId: string;
  /** Pre-fills the "Mark as paid" amount input — usually the occurrence's own `expectedAmount`. */
  expectedAmount: string | null;
  /** Drives the settle wording — an inflow is "received", an outflow is "paid". */
  direction: 'inflow' | 'outflow';
}

/**
 * The primary settlement UI for a `scheduled` occurrence — detection was
 * dropped, so this inline pair (mark paid/received / skip) is how
 * occurrences normally resolve, on both the overview feed and a payment's
 * own history. Opens an inline amount editor rather than a modal (mirrors
 * `VaultDetailPage`'s percentage editor) because the amount is usually
 * already known (`expectedAmount`) and only needs confirming.
 */
export function OccurrenceActions({
  occurrenceId,
  expectedAmount,
  direction,
}: OccurrenceActionsProps) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(expectedAmount ?? '');
  const utils = trpc.useUtils();
  const settleLabel = direction === 'inflow' ? 'Mark as received' : 'Mark as paid';
  const settledLabel = direction === 'inflow' ? 'Marked as received' : 'Marked as paid';

  const settleMutation = trpc.payments.settleOccurrence.useMutation({
    onSuccess: (_, variables) => {
      setEditing(false);
      showSuccess(variables.status === 'skipped' ? 'Occurrence skipped' : settledLabel);
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, 'Updating payment occurrence'),
  });

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <NumericFormat
          value={amount}
          onValueChange={(v) => setAmount(v.value)}
          customInput={Input}
          className="h-7 w-24 text-xs"
          decimalScale={2}
          allowNegative={false}
          autoFocus
          disabled={settleMutation.isPending}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={settleMutation.isPending || amount.length === 0}
          onClick={() =>
            settleMutation.mutate({
              occurrenceId,
              status: 'matched',
              actualAmount: amount,
            })
          }
        >
          <Check className="h-3 w-3 mr-1" />
          Confirm
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={settleMutation.isPending}
          onClick={() => setEditing(false)}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() => {
          setAmount(expectedAmount ?? '');
          setEditing(true);
        }}
      >
        <Check className="h-3 w-3 mr-1" />
        {settleLabel}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-muted-foreground"
        disabled={settleMutation.isPending}
        onClick={() => settleMutation.mutate({ occurrenceId, status: 'skipped' })}
      >
        Skip
      </Button>
    </div>
  );
}
