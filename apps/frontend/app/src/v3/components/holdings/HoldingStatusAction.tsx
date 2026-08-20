import type { HoldingWithDetails } from '@scani/shared';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

/**
 * Take a holding out of the portfolio total, or put it back.
 *
 * This replaces a control that was not one. Status rendered as a filled
 * primary-purple pill reading "Active" — the same fill as `Add payment` and the
 * `Add` tab — whose only admission that it was a button at all was an
 * `aria-label` saying "Deactivate BTC". One tap took a €73k position out of the
 * portfolio, with no confirm and no toast, from a 57×25px target. Two separate
 * defects, and SC-63 is the argument for fixing both at once: a state that can
 * be changed has to look changeable, and changing it has to confirm.
 *
 * So the status splits in two. The `Status` fact goes back to being a fact — a
 * badge that says which state the holding is in and cannot be pressed — and the
 * act of changing it moves into the peek's action row next to `Refresh price`
 * and `Delete`, where every other thing you can do to a holding already lives
 * and where a labelled button reads as a button. It is the same move `Delete`
 * made in the v3 port: v2's unlabelled 32px icon in the corner became a word.
 *
 * Not `destructive`. Deactivating has an exact inverse sitting in the same
 * place — this component *is* the inverse — and spending the red on a
 * reversible act is what makes it stop meaning anything on `Delete`, which has
 * none. `PaymentStatusToggle` opts out for the same reason.
 *
 * The consequence names the figure, because the figure is the whole effect:
 * "deactivated" describes nothing a reader can check, and "€73,782.40 comes off
 * your portfolio total" is the thing they would have noticed on the home screen
 * an hour later without knowing why.
 */

interface HoldingStatusActionProps {
  holding: HoldingWithDetails;
  /** Base-currency symbol or code, for the figure in the sentence. */
  currency: string;
  onToggle: (holding: HoldingWithDetails) => void;
  isPending?: boolean;
}

export function HoldingStatusAction({
  holding,
  currency,
  onToggle,
  isPending,
}: HoldingStatusActionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = holding.isActive
    ? t('v3.holdings.status.deactivateAction')
    : t('v3.holdings.status.activateAction');

  return (
    <ConfirmAction
      label={label}
      confirmLabel={t('v3.holdings.status.confirm', { label, symbol: holding.token.symbol })}
      open={open}
      onOpenChange={setOpen}
      isPending={isPending}
      consequence={
        // `<Trans>` rather than lead + `<Numeric>` + tail, matching the delete
        // action beside it (SC-235). The two halves were one sentence with the
        // figure wedged into the middle of it, so a translator could change
        // the words on either side and never move the amount — and the amount
        // is the part of this sentence a reader is deciding on.
        <Trans
          i18nKey={
            holding.isActive
              ? 'v3.holdings.status.deactivateConsequence'
              : 'v3.holdings.status.activateConsequence'
          }
          values={{ symbol: holding.token.symbol, account: holding.account.name }}
          components={{
            value: <Numeric value={holding.value} currency={currency} className="text-caption" />,
          }}
        />
      }
      onConfirm={() => {
        // Closed here rather than on the mutation settling: `updateHolding`
        // patches the cache optimistically, so by the next frame the badge two
        // rows below already reads the new state and this button already reads
        // the inverse verb. A confirmation still standing over that is asking
        // about something that has visibly happened.
        setOpen(false);
        onToggle(holding);
      }}
    />
  );
}
