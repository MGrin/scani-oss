import { formatDate } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { ArrowDownLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import { INCOME_HORIZON_DAYS, occurrenceTotals, PAYMENTS_HORIZON_DAYS } from '../../lib/money';
import { BaseEquivalent } from '../BaseEquivalent';
import { ConvertedTotal } from '../ConvertedTotal';

/**
 * Money coming in — a **forecast**, kept in its own block rather than mixed
 * into the bill feed above it.
 *
 * V3-47: income used to be listed among the bills, under a figure that had been
 * filtered to outflow. The number was right and the list beneath it was not,
 * which is the shape of the defect; but the fix is not simply to hide income,
 * because an income invoice and a bill are two different kinds of fact. A bill
 * is an obligation with a deadline — the reader's job is to cover it. An income
 * occurrence is a date somebody else has to meet, and the reader's question
 * about it is "how much is coming, and roughly when": a forecast to plan
 * around, not a chore to work through.
 *
 * So this block leads with the aggregate rather than with the rows, runs over
 * ninety days rather than thirty (see `INCOME_HORIZON_DAYS`), and never appears
 * in the same figure as the bills. Nothing on this screen nets the two: a
 * single "you're €400 up this month" would silently average a near-certain
 * obligation against a client's intention, and the reliability of those two
 * claims is not the same.
 *
 * The rows carry `<Numeric delta>` — the sign, the arrow and the gain token
 * v3 already uses for a figure whose direction matters, rather than a colour
 * or a badge invented here.
 *
 * The aggregate is a `<ConvertedTotal>`, the same component the bills figure
 * above it uses (V3-52). That is deliberate: income spanning currencies has to
 * become one number in the reader's own currency for exactly the reason bills
 * did — a forecast printed as "€180 · Plus $300" is not something anyone can
 * plan against — and routing both through one component is what keeps the
 * rates, the staleness wording and the treatment of an unconvertible currency
 * identical on the two figures.
 */

type UpcomingOccurrence = RouterOutputs['payments']['upcoming'][number];

interface ExpectedIncomeProps {
  /** Income occurrences only, already inside the income horizon. */
  occurrences: UpcomingOccurrence[];
  vendorNameById: Map<string, string>;
  tokenSymbolById: Map<string, string>;
  /** The same rates the bills figure converts through — one query, one set of
   *  rates, so the two figures can never be as-of different days. */
  rates: BaseCurrencyRates;
  today: string;
  onPeek: (occurrenceId: string) => void;
}

export function ExpectedIncome({
  occurrences,
  vendorNameById,
  tokenSymbolById,
  rates,
  today,
  onPeek,
}: ExpectedIncomeProps) {
  const { t } = useTranslation();
  // No income at all is not a fact worth a block. A reader with only bills is
  // looking at a bills screen, and an empty "expected income" panel under it
  // would be chrome describing something that does not exist.
  if (occurrences.length === 0) return null;

  const totals = occurrenceTotals(occurrences);
  const rows = [...occurrences].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return (
    <Block className="flex flex-col">
      <div className="flex flex-col gap-2 p-4">
        {/* `default`, not `hero`: the view's one hero is the bills figure above,
            and two display-size numbers on a screen is the invitation to
            compare them this whole ticket exists to withdraw. */}
        <ConvertedTotal
          delta
          emphasis="default"
          label={t('v3.money.expectedIncome.title', { count: INCOME_HORIZON_DAYS })}
          totals={totals}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
        />
        {/* Said in words, because the difference between the two figures on this
            screen is one of *certainty*, and no amount of layout carries that. */}
        <p className="text-caption text-muted-foreground">
          {t('v3.money.expectedIncome.caption', { count: PAYMENTS_HORIZON_DAYS })}
        </p>
      </div>

      <DataRowList className="border-t border-border">
        {rows.map((occurrence) => {
          const vendorName =
            vendorNameById.get(occurrence.payment.vendorId) ??
            t('v3.money.expectedIncome.unknownPayer');
          const late = occurrence.dueDate < today;
          return (
            <DataRow
              key={occurrence.id}
              leading={
                <ArrowDownLeft aria-hidden="true" className="size-4 text-muted-foreground" />
              }
              label={vendorName}
              // Every row carries its own date: this block is not grouped by
              // date, because a quarter of income is a handful of rows and
              // eleven single-row date headings would be longer than the list.
              // "Not received yet" rather than the bill feed's "3 days
              // overdue": nobody is late on their own account here, and calling
              // a client's slow invoice overdue reads as the reader's problem.
              sublabel={
                // The date is interpolated through `formatDate` (APP_LOCALE,
                // en-GB) rather than being part of the key.
                late
                  ? t('v3.money.expectedIncome.expectedLate', {
                      date: formatDate(occurrence.dueDate),
                    })
                  : t('v3.money.expectedIncome.expected', {
                      date: formatDate(occurrence.dueDate),
                    })
              }
              value={
                <Numeric
                  delta
                  indicator="sign"
                  value={occurrence.expectedAmount ?? occurrence.actualAmount}
                  currency={tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? 'USD'}
                />
              }
              // The row keeps the currency it will actually arrive in; the line
              // under it says what that is worth in the reader's, the same way
              // a bill row does.
              delta={
                <BaseEquivalent
                  amount={occurrence.expectedAmount ?? occurrence.actualAmount}
                  currencyTokenId={occurrence.payment.currencyTokenId}
                  rates={rates}
                />
              }
              onClick={() => onPeek(occurrence.id)}
              aria-label={t('v3.money.expectedIncome.row', {
                vendor: vendorName,
                date: formatDate(occurrence.dueDate),
              })}
            />
          );
        })}
      </DataRowList>
    </Block>
  );
}
