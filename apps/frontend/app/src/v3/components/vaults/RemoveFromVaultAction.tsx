import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { CircleMinus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { attributedValue, type VaultHoldingRow as VaultHoldingRowData } from '../../lib/vaults';

/** Taking a holding out of a vault, as a destructive action in the member's
 *  peek header (UI standard rules 6 and 12, SC-1433). */
export function RemoveFromVaultAction({
  holding,
  currencySymbol,
  onDetach,
}: {
  holding: VaultHoldingRowData;
  currencySymbol: string;
  onDetach: (holdingId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const symbol = holding.tokenSymbol || t('v3.vaults.holding.thisHolding');
  return (
    <ConfirmAction
      label={
        <>
          <CircleMinus className="me-2 size-4" aria-hidden="true" />
          {t('v3.vaults.holding.remove')}
        </>
      }
      triggerClassName="text-destructive hover:text-destructive"
      destructive
      confirmLabel={t('v3.vaults.holding.removeCommit', { symbol })}
      open={open}
      onOpenChange={setOpen}
      consequence={
        // One sentence, one key, the figure as a slot (SC-235). Split into
        // lead and tail around `<Numeric>` it read correctly only in a
        // language that puts the amount exactly there.
        <Trans
          i18nKey="v3.vaults.holding.detachConsequence"
          values={{ symbol, percent: holding.percentage }}
          components={{
            value: (
              <Numeric
                value={attributedValue(holding)}
                currency={currencySymbol}
                className="text-caption"
              />
            ),
          }}
        />
      }
      onConfirm={() => {
        onDetach(holding.holdingId);
        setOpen(false);
      }}
    />
  );
}
