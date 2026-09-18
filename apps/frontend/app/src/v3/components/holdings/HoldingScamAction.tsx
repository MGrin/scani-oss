import type { HoldingWithDetails } from '@scani/shared';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

/**
 * Say that this token is a scam, for yourself (SC-1160).
 *
 * The product could only ever take a scam flag AWAY — `Not a scam` on the
 * hidden list — so a reader who spotted one the automatic scorer missed had no
 * way to say so. mgrin ruled on 2026-09-14 that they may, and that it must
 * change the token for them and nobody else; the verdict is also recorded, so
 * a person can decide from many of them whether to flag it for everyone.
 *
 * It confirms because the effect is on the total, like deactivating: the
 * holding leaves it and moves to the hidden list, and the sentence names the
 * figure for the same reason `HoldingStatusAction`'s does. Not `destructive` —
 * `Not a scam` on that list is the exact inverse, and it is yours alone.
 */

interface HoldingScamActionProps {
  holding: HoldingWithDetails;
  /** Base-currency symbol or code, for the figure in the sentence. */
  currency: string;
  onMarkScam: (holding: HoldingWithDetails) => void;
  isPending?: boolean;
}

export function HoldingScamAction({
  holding,
  currency,
  onMarkScam,
  isPending,
}: HoldingScamActionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <ConfirmAction
      label={t('v3.holdings.scam.markAction')}
      confirmLabel={t('v3.holdings.scam.confirm', { symbol: holding.token.symbol })}
      open={open}
      onOpenChange={setOpen}
      isPending={isPending}
      consequence={
        <Trans
          i18nKey="v3.holdings.scam.consequence"
          values={{ symbol: holding.token.symbol }}
          components={{
            value: <Numeric value={holding.value} currency={currency} className="text-caption" />,
          }}
        />
      }
      onConfirm={() => {
        setOpen(false);
        onMarkScam(holding);
      }}
    />
  );
}
