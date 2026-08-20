import type { HoldingWithDetails } from '@scani/shared';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <ConfirmAction
      label={
        <>
          <Trash2 className="mr-2 size-4" aria-hidden="true" />
          {t('v3.holdings.deleteAction.trigger')}
        </>
      }
      triggerClassName="text-destructive hover:text-destructive"
      confirmLabel={t('v3.holdings.deleteAction.commit', { symbol: holding.token.symbol })}
      destructive
      open={open}
      onOpenChange={setOpen}
      isPending={isPending}
      consequence={
        // `<Trans>` rather than `t()`, because the figure is a rendered node
        // sitting INSIDE the sentence. Splitting it into two `t()` halves with
        // `<Numeric>` between them would hand a translator two fragments and
        // pin English word order into the JSX — and no language is obliged to
        // put the amount between "recorded against it" and "comes off your
        // portfolio total". One sentence, one key, the figure as a slot.
        <Trans
          i18nKey="v3.holdings.deleteAction.consequence"
          values={{ symbol: holding.token.symbol, account: holding.account.name }}
          components={{
            value: <Numeric value={holding.value} currency={currency} className="text-caption" />,
          }}
        />
      }
      onConfirm={() => onDelete(holding)}
    />
  );
}
