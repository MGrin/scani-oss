import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans } from 'react-i18next';
import type { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { convertAmountToBase } from '../lib/paymentTotals';

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

  const figure = <Numeric value={converted.amount.toString()} currency={rates.baseSymbol} />;

  // Seen and spoken are two whole phrases rather than one figure wearing a
  // prefix and a suffix (SC-235). "About " before it and " · older rate" after
  // it were both pinned by their position in this element, so a translator
  // could rewrite either and move neither — and the seen register uses a glyph
  // where the spoken one needs a word, which is a difference no single key can
  // carry. The figure renders twice; only one of the two is ever announced.
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">
        <Trans
          i18nKey={
            converted.stale ? 'v3.common.baseEquivalent.seenStale' : 'v3.common.baseEquivalent.seen'
          }
          components={{ value: figure }}
        />
      </span>
      <span className="sr-only">
        <Trans
          i18nKey={
            converted.stale
              ? 'v3.common.baseEquivalent.spokenStale'
              : 'v3.common.baseEquivalent.spoken'
          }
          components={{ value: figure }}
        />
      </span>
    </span>
  );
}
