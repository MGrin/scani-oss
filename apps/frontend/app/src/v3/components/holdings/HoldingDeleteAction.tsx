import type { HoldingWithDetails } from '@scani/shared';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

/**
 * Delete one holding, from the peek sheet that record is open in.
 *
 * The last v3 destructive action still asking through a page-mounted
 * `ConfirmDialog` (SC-73). It *did* confirm, so this is not the one-tap defect
 * its neighbours had — it is the consistency one, and it matters for a reason
 * beyond tidiness: `/holdings` was asking the same question two different ways
 * on the same screen. The bulk bar's `Delete` (SC-63) confirms inline, in the
 * bar, leading with Cancel; the peek's `Delete` opened a Radix dialog over a
 * sheet resting at half the viewport, which is exactly the two-dismiss-gestures
 * stack §8.1 rejected and which `BulkDeleteAction`'s own note argues against.
 * A reader who deletes a row one way and then the other way meets two
 * different affordances for one act.
 *
 * So it moves onto `ConfirmAction`, beside `Refresh price`, `Sync balance` and
 * `HoldingStatusAction` — the peek action row is a wrapping flex, so the open
 * block claims its own line under the facts about the holding, and those facts
 * are still on screen while the sentence is read. That is the property a modal
 * over the sheet gave away.
 *
 * `destructive`, unlike `HoldingStatusAction` directly beside it: deactivating
 * has an exact inverse and this has none — the transactions go with the row.
 * The consequence names the figure and the account for the same reason
 * `HoldingStatusAction` does: "this holding" identifies nothing on a screen
 * where the same token is held in four accounts.
 */

interface HoldingDeleteActionProps {
  holding: HoldingWithDetails;
  /** Base-currency symbol or code, for the figure in the sentence. */
  currency: string;
  onDelete: (holding: HoldingWithDetails) => void;
  isPending?: boolean;
}

export function HoldingDeleteAction({
  holding,
  currency,
  onDelete,
  isPending,
}: HoldingDeleteActionProps) {
  const [open, setOpen] = useState(false);

  return (
    <ConfirmAction
      label={
        <>
          <Trash2 className="mr-2 size-4" aria-hidden="true" />
          Delete
        </>
      }
      triggerClassName="text-destructive hover:text-destructive"
      confirmLabel={`Delete ${holding.token.symbol}`}
      destructive
      open={open}
      onOpenChange={setOpen}
      isPending={isPending}
      consequence={
        <>
          {`${holding.token.symbol} in ${holding.account.name} is removed, along with every transaction recorded against it — `}
          <Numeric value={holding.value} currency={currency} className="text-caption" />
          {
            ' comes off your portfolio total. Nothing restores it; a re-import would have to rebuild the history. To take it out of the total and keep the record, use Deactivate.'
          }
        </>
      }
      onConfirm={() => onDelete(holding)}
    />
  );
}
