import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { convertAmountToBase } from '@/v2/lib/paymentTotals';

/**
 * The base-currency equivalent of a row's own figure — the secondary line
 * under a €, $ or £ amount when the reader banks in something else.
 *
 * The row keeps its own currency: a bill of £120 *is* £120, and rewriting it
 * would be a different claim about what leaves the account. This line is
 * explicitly derived — "≈", one type size down, muted — so it reads as our
 * arithmetic rather than as the invoice.
 *
 * Renders nothing when the row is already in base currency, has no amount, or
 * has no rate. A row does not sprout an apology; the total above it is where
 * an un-convertible amount is accounted for, because that is the figure it
 * would otherwise silently understate.
 */

interface BaseEquivalentProps {
  amount: string | null;
  currencyTokenId: string;
  rates: ReturnType<typeof useBaseCurrencyRates>;
}

export function BaseEquivalent({ amount, currencyTokenId, rates }: BaseEquivalentProps) {
  const converted = convertAmountToBase(amount, currencyTokenId, rates);
  if (!converted) return null;

  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">≈ </span>
      <span className="sr-only">About </span>
      <Numeric value={converted.amount.toString()} currency={rates.baseSymbol} />
      {converted.stale ? ' · older rate' : null}
    </span>
  );
}
