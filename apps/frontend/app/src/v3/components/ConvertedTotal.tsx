import { type Decimal, formatDate } from '@scani/shared';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { convertTotalsToBase } from '@/v2/lib/paymentTotals';

/**
 * One figure, in the reader's own currency, from a total that spans several.
 *
 * v3 used to print the per-currency map as it came — "€94.97 · Plus $23.00" —
 * on the grounds that unlike currencies must never be silently added. The
 * instinct was right and the application was wrong: we hold FX rates, so the
 * honest move is not to refuse the sum but to convert it and say so. A reader
 * asking "what is going out this month" is asking one question and deserves
 * one number.
 *
 * Two rules the caption below the figure enforces:
 *
 * - **A converted total says how much of it was converted** — the amount in
 *   each foreign currency it folded in, not just their names — and dates the
 *   rates when they are older than the day the app promises everywhere else.
 *   Naming the currency alone made the caption a claim about the whole figure
 *   ("Converted from GBP") when it was usually a claim about a small part of
 *   one that is otherwise already in the reader's own money.
 * - **Nothing un-convertible is dropped.** A currency with no rate is named
 *   with its amount, below the figure it is missing from. Quietly omitting it
 *   would understate what the user owes, which is worse than the list this
 *   replaced.
 */

interface ConvertedTotalProps {
  label: string;
  /** Per-currency totals, straight from `sumAmountsByCurrency` and friends. */
  totals: ReadonlyMap<string, Decimal>;
  tokenSymbolById: Map<string, string>;
  /** Rates come from the page, not from a query in here: these surfaces stay
   *  renderable without a tRPC client, which is what makes them assertable. */
  rates: BaseCurrencyRates;
  /** A view has exactly one hero (§2.1). A second converted total on the same
   *  screen — "paid" beside "committed" — is a `default` tile. */
  emphasis?: 'default' | 'hero';
  /** The figure is money moving in a direction rather than a magnitude, so it
   *  carries `<Numeric>`'s sign and gain token — expected income (V3-47) is the
   *  only such total today. A bill total is deliberately unsigned: "−€480" for
   *  what you owe would be a claim about a balance, not about a bill. */
  delta?: boolean;
}

export function ConvertedTotal({
  label,
  totals,
  tokenSymbolById,
  rates,
  emphasis = 'hero',
  delta = false,
}: ConvertedTotalProps) {
  const total = convertTotalsToBase(totals, rates);

  const symbolFor = (currencyTokenId: string) =>
    tokenSymbolById.get(currencyTokenId) ?? rates.baseSymbol;

  // `convertedFrom` is currency ids; the amount each contributed is what the
  // caller already handed us, before conversion.
  const convertedParts = total.convertedFrom.flatMap((currencyTokenId) => {
    const amount = totals.get(currencyTokenId);
    return amount ? [{ currencyTokenId, amount }] : [];
  });

  return (
    <>
      <StatTile
        emphasis={emphasis}
        label={label}
        // A zero still has to be denominated, and the reader's own currency is
        // the only defensible guess — "$0.00" to someone who banks in euros is
        // a figure about the wrong money.
        value={
          <Numeric delta={delta} value={total.amount.toString()} currency={rates.baseSymbol} />
        }
      />

      {/* Names the PART that was converted, with its own figure — not the
          total.
          "Converted from GBP at today's rates" under a figure that is mostly
          euros says the whole number came out of sterling; it sat under an
          income total of two EUR inflows and one GBP one and was read exactly
          that way (SC-69 3.2). What the reader needs to judge the number is
          how much of it went through a rate, so that is what this prints. The
          currencies with no rate at all keep their own sentence below. */}
      {convertedParts.length > 0 ? (
        <p className="text-caption text-muted-foreground">
          Includes{' '}
          {convertedParts.map((part, index) => (
            <span key={part.currencyTokenId}>
              {index > 0 ? ', ' : ''}
              <Numeric value={part.amount.toString()} currency={symbolFor(part.currencyTokenId)} />
            </span>
          ))}{' '}
          {total.stale && total.ratesAsOf
            ? `converted at rates from ${formatDate(total.ratesAsOf.toISOString())}`
            : 'converted at today’s rates'}
        </p>
      ) : null}

      {total.unconverted.length > 0 ? (
        <p className="text-caption text-muted-foreground">
          Not included:{' '}
          {total.unconverted.map((part, index) => (
            <span key={part.currencyTokenId}>
              {index > 0 ? ', ' : ''}
              <Numeric value={part.amount.toString()} currency={symbolFor(part.currencyTokenId)} />
            </span>
          ))}{' '}
          — no recent rate for{' '}
          {total.unconverted.map((part) => symbolFor(part.currencyTokenId)).join(', ')}.
        </p>
      ) : null}
    </>
  );
}
