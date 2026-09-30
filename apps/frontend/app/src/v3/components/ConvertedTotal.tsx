import { type Decimal, formatDate } from '@scani/shared';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { convertTotalsToBase, type UnconvertedPart } from '../lib/paymentTotals';

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
 *
 * And the rule SC-210 added, which the two above are worth nothing without:
 *
 * - **A figure that is still being worked out is not shown.** While the rates
 *   are in flight every foreign part is missing, so the sum is the reader's
 *   own currency alone — on the reported book, $425 against a true $888. It
 *   was rendered at hero size, believed, and replaced a second later. A
 *   skeleton says the same thing honestly. When the rates never arrive at all
 *   the figure IS shown, because there is nothing better coming, but it says
 *   what is missing from it in a sentence that blames the fetch rather than
 *   the currency.
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
  const { t } = useTranslation();
  const total = convertTotalsToBase(totals, rates);

  const symbolFor = (currencyTokenId: string) =>
    tokenSymbolById.get(currencyTokenId) ?? rates.baseSymbol;

  if (total.pending) {
    // The tile keeps its label and its place; only the figure waits. Skeleton
    // straight away rather than through `useDelayedLoading`: this is a
    // secondary query filling one slot of a surface the reader is already
    // looking at, which is the same shape as `HeroBlock`'s pending delta, and
    // the ramp's 300ms of nothing exists to stop a whole screen flashing.
    return (
      <StatTile
        emphasis={emphasis}
        label={label}
        value={
          <>
            <Skeleton aria-hidden="true" className="h-9 w-40" />
            <span className="sr-only" role="status">
              {t('v3.common.convertedTotal.working')}
            </span>
          </>
        }
      />
    );
  }

  // `convertedFrom` is currency ids; the amount each contributed is what the
  // caller already handed us, before conversion.
  const convertedParts = total.convertedFrom.flatMap((currencyTokenId) => {
    const amount = totals.get(currencyTokenId);
    return amount ? [{ currencyTokenId, amount }] : [];
  });

  // Nothing at all converted and nothing in the reader's own currency either:
  // `amount` is zero because every part is missing, not because the total is
  // nothing. "$0.00" would be the most confident wrong answer on the screen.
  const nothingKnown = totals.size > 0 && total.unknown.length === totals.size;

  return (
    <>
      <StatTile
        emphasis={emphasis}
        label={label}
        // A zero still has to be denominated, and the reader's own currency is
        // the only defensible guess — "$0.00" to someone who banks in euros is
        // a figure about the wrong money.
        value={
          nothingKnown ? (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">{t('v3.common.convertedTotal.noTotal')}</span>
            </>
          ) : (
            <Numeric delta={delta} value={total.amount.toString()} currency={rates.baseSymbol} />
          )
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
      {/* `<Trans>` rather than `t()`, because the figures are rendered nodes
          sitting INSIDE the sentence (SC-201). Building this as
          `t('includes') + <amounts/> + t('atTodaysRates')` would hand a
          translator two half-sentences and pin English word order into the
          JSX — and "Includes X converted at today's rates" does not put its
          verb, its object or its date in that order in most of the eight
          languages this is being extracted for. The amount list is one slot;
          the whole sentence is one key. */}
      {convertedParts.length > 0 ? (
        <p className="text-caption text-muted-foreground">
          <Trans
            i18nKey={
              total.stale && total.ratesAsOf
                ? 'v3.common.convertedTotal.includesStale'
                : 'v3.common.convertedTotal.includes'
            }
            values={{
              date: total.ratesAsOf ? formatDate(total.ratesAsOf.toISOString()) : '',
            }}
            components={{ amounts: <AmountList parts={convertedParts} symbolFor={symbolFor} /> }}
          />
        </p>
      ) : null}

      {total.unconverted.length > 0 ? (
        <p className="text-caption text-muted-foreground">
          <Trans
            i18nKey="v3.common.convertedTotal.notIncluded"
            // `join(', ')` is English list punctuation and stays that way in
            // this step — no behaviour change. `Intl.ListFormat` is the right
            // answer and belongs with step 5, where formatting starts
            // following the chosen language.
            values={{
              currencies: total.unconverted
                .map((part) => symbolFor(part.currencyTokenId))
                .join(', '),
            }}
            components={{ amounts: <AmountList parts={total.unconverted} symbolFor={symbolFor} /> }}
          />
        </p>
      ) : null}

      {/* Its own sentence, and deliberately not the one above it (SC-210).
          "No recent rate for GBP" is a claim about sterling; these parts are
          missing because a request failed, which is a claim about us. Merging
          them told the reader something false about their own currencies every
          time the FX service had a bad minute — and, because the two states
          were the same value, told them nothing about the figure being
          incomplete. */}
      {total.unknown.length > 0 ? (
        <p className="text-caption text-muted-foreground" role="status">
          <Trans
            i18nKey="v3.common.convertedTotal.ratesUnavailable"
            components={{ amounts: <AmountList parts={total.unknown} symbolFor={symbolFor} /> }}
          />
        </p>
      ) : null}
    </>
  );
}

/** The `<amounts>` slot every caption above interpolates: figures, comma-
 *  separated, each in its own currency. */
function AmountList({
  parts,
  symbolFor,
}: {
  parts: readonly UnconvertedPart[];
  symbolFor: (currencyTokenId: string) => string;
}) {
  return (
    <>
      {parts.map((part, index) => (
        <span key={part.currencyTokenId}>
          {index > 0 ? ', ' : ''}
          <Numeric value={part.amount.toString()} currency={symbolFor(part.currencyTokenId)} />
        </span>
      ))}
    </>
  );
}
