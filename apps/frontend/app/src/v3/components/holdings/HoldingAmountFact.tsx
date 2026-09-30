import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import { amountDecimals, balanceIsBelowZero } from '../../lib/holdings';
import { LookalikeBadge } from './LookalikeBadge';

/**
 * The unit count, as the peek's first fact.
 *
 * It was editable in place, behind a pencil, until SC-1436: the holding was
 * then the one record edited unlike every other, so the count is a readout
 * here and changes through the peek's Edit action and `EditHoldingSheet`
 * (UI standard rule 13).
 */

interface HoldingAmountFactProps {
  /** The exact balance, as a decimal string (SC-567). */
  amount: string;
  /**
   * What the count counts (SC-559).
   *
   * The fact rendered a bare number and named its unit nowhere — the reader
   * recovered "which token is this" from the sheet's title or not at all, and
   * mgrin reported that from production. The symbol is not a decoration on the
   * figure; without it the figure is not a quantity.
   */
  symbol: string;
  /**
   * The symbol this one draws, when it draws somebody else's.
   *
   * Printing the symbol here is the thing `holdingsConfig` warns about: a bare
   * `UЅDС` beside a number is indistinguishable from `USDC` and carries no
   * warning of its own. The list badges the symbol in the row's identity zone;
   * this sheet had no badge anywhere, so the unit brings its own.
   */
  lookalikeOf?: string | null;
}

export function HoldingAmountFact({ amount, symbol, lookalikeOf }: HoldingAmountFactProps) {
  const { t } = useTranslation();

  return (
    <span className="flex min-w-0 flex-col items-end gap-0.5">
      <span className="flex min-w-0 items-center justify-end gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <Numeric value={amount} format="plain" decimals={amountDecimals(amount)} />
          <span className="truncate">{symbol}</span>
        </span>
        {lookalikeOf ? <LookalikeBadge symbol={symbol} impersonates={lookalikeOf} t={t} /> : null}
      </span>
      {/* Stacked under the figure, the way a price's age is, and for the
          same stated reason: the caption is what decides whether to trust
          the number above it. A negative balance is unreachable through
          any request a person can make (see `balanceIsBelowZero`), so left
          bare it reads as the app having lost their money rather than as a
          figure they are free to correct — through the peek's Edit (SC-632). */}
      {balanceIsBelowZero(amount) ? (
        <span className="text-caption text-muted-foreground text-end">
          {t('v3.holdings.amountFact.belowZero')}
        </span>
      ) : null}
    </span>
  );
}
