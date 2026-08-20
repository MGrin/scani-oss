import { Button } from '@scani/ui/ui/button';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { peekOpenState, peekPath } from '@scani/ui/v3/lib/peek';
import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { trpc } from '@/lib/trpc';
import { formatDueIn, nextPayments } from '../../lib/home';
import {
  INCOME_HORIZON_DAYS,
  occurrenceTotals,
  PAYMENTS_HORIZON_DAYS,
  splitByDirection,
  splitByDueness,
  withinDays,
} from '../../lib/money';
import { todayDateString } from '../../lib/paymentTotals';
import { V3_ROUTES } from '../../lib/routes';
import { BaseEquivalent } from '../BaseEquivalent';
import { ConvertedFigure } from '../ConvertedFigure';

/**
 * What is due — V3-09's fifth block, moved out of `HomePage` unchanged so every
 * block on the screen is a component that owns its own queries. That is what
 * lets V3-37 rearrange them into a grid without reading any of their internals.
 *
 * V3-47 made the rows **bills only**. The block used to list whatever fell due
 * next, income included, which turned a client's invoice into an item on a list
 * of things the reader has to do. Income is not a chore and it is not on a
 * deadline the reader owns, so it appears here the way a forecast should: as
 * one aggregate over a longer window, at the foot of the block, in the sign
 * treatment `<Numeric delta>` already gives every directional figure in v3.
 * Nothing here nets the two.
 */

/** The next three bills. A fourth row pushes the block below the fold. */
const PAYMENTS_SHOWN = 3;

interface UpcomingBlockProps {
  /** Fallback for an occurrence whose own currency token is unknown. */
  currency: string;
}

export function UpcomingBlock({ currency }: UpcomingBlockProps) {
  const { t } = useTranslation();
  // The income window, which is the longer one — the same query the Money tab
  // issues, so the two share a cache entry and can never disagree about the
  // total they both print.
  const payments = trpc.payments.upcoming.useQuery({ days: INCOME_HORIZON_DAYS });
  const vendors = trpc.vendors.list.useQuery();
  const tokens = trpc.tokens.getAll.useQuery();

  const today = todayDateString();
  const { bills, income } = splitByDirection(payments.data ?? []);
  const due = nextPayments(withinDays(bills, today, PAYMENTS_HORIZON_DAYS), today, PAYMENTS_SHOWN);
  const incomeTotals = occurrenceTotals(income);
  // `nextPayments` keeps only what is still ahead, so overdue bills were not
  // three rows down this block — they were absent from the home screen
  // entirely, uncounted and unnamed (SC-77 1). They get the same treatment
  // income gets: one aggregate line, its own figure, never folded into
  // anything above it.
  const { overdue } = splitByDueness(bills, today);
  const overdueTotals = occurrenceTotals(overdue);

  const vendorNameById = new Map(
    (vendors.data ?? []).map((vendor) => [vendor.id, vendor.displayName])
  );
  const tokenSymbolById = new Map((tokens.data ?? []).map((token) => [token.id, token.symbol]));
  // A bill in another currency keeps its own figure; the second line under it
  // says what it costs in the reader's. The income currencies are asked for in
  // the same breath — the aggregate at the foot converts through these rates
  // too, and a rate query that covered only the bills would leave it printing
  // a currency list under a screen full of converted numbers.
  const rates = useBaseCurrencyRates([
    ...due.map((occurrence) => occurrence.payment.currencyTokenId),
    ...overdue.map((occurrence) => occurrence.payment.currencyTokenId),
    ...income.map((occurrence) => occurrence.payment.currencyTokenId),
  ]);

  return (
    <Block>
      <BlockHeader
        title={t('v3.home.upcoming.title')}
        href={V3_ROUTES.money}
        action={t('v3.common.action.seeAll')}
      />
      {due.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-4 pb-4">
          <p className="text-body text-muted-foreground">
            {t('v3.home.upcoming.empty', { count: PAYMENTS_HORIZON_DAYS })}
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to={V3_ROUTES.recurring}>{t('v3.home.upcoming.addPayment')}</Link>
          </Button>
        </div>
      ) : (
        <DataRowList className="border-t border-border">
          {due.map((occurrence) => {
            const vendorName =
              vendorNameById.get(occurrence.payment.vendorId) ?? t('v3.common.unknownVendor');
            return (
              <DataRow
                key={occurrence.id}
                leading={
                  <CalendarClock aria-hidden="true" className="size-4 text-muted-foreground" />
                }
                label={vendorName}
                sublabel={formatDueIn(occurrence.dueDate, today, t)}
                // The two cards beside this one — Top holdings and Groups — are
                // runs of `DataRow`s with an `onClick`, at the same row height
                // and in the same style. These rows had none, so on the first
                // screen of the app three rows that look exactly like their
                // tappable neighbours did nothing at all when tapped (SC-69
                // 2.1); on a phone there is no hover to reveal which is which.
                // The peek already exists at `/payments/:occurrenceId` — this
                // opens the same sheet the Money tab opens. A link rather than
                // a button that navigates (SC-74): the destination is a URL, so
                // making the row a control should not cost the reader the URL.
                href={peekPath(V3_ROUTES.money, occurrence.id)}
                linkState={peekOpenState(V3_ROUTES.money)}
                aria-label={t('v3.common.openRecord', { name: vendorName })}
                value={
                  <Numeric
                    value={occurrence.expectedAmount ?? occurrence.actualAmount}
                    currency={tokenSymbolById.get(occurrence.payment.currencyTokenId) ?? currency}
                  />
                }
                delta={
                  <BaseEquivalent
                    amount={occurrence.expectedAmount ?? occurrence.actualAmount}
                    currencyTokenId={occurrence.payment.currencyTokenId}
                    rates={rates}
                  />
                }
              />
            );
          })}
        </DataRowList>
      )}

      {/* One line, not three rows: "plan the income" is a question about a
          total over a horizon, and listing each expected payment as its own
          item is what put income among the chores in the first place. One
          *number* on that line, too — `<ConvertedFigure>` is the inline form of
          the conversion the Money tab's figures get, so an income invoice in
          another currency is folded in rather than trailing the line. */}
      {/* `flex-wrap` and no `whitespace-nowrap` on the row below (SC-71 9.2):
          the healthy state is one clean figure and fits, but the degraded one
          carries a tail, and a row that cannot wrap loses the end of it behind
          the card edge rather than dropping to a second line. */}
      {overdue.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-3">
          <span className="text-caption text-muted-foreground">
            {t('v3.money.upcoming.overdueTotal', { count: overdue.length })}
          </span>
          <span className="text-label">
            <ConvertedFigure
              totals={overdueTotals}
              tokenSymbolById={tokenSymbolById}
              rates={rates}
            />
          </span>
        </div>
      ) : null}

      {income.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-3">
          <span className="text-caption text-muted-foreground">
            {t('v3.home.upcoming.incomeExpected', { count: INCOME_HORIZON_DAYS })}
          </span>
          <span className="text-label">
            <ConvertedFigure
              delta
              totals={incomeTotals}
              tokenSymbolById={tokenSymbolById}
              rates={rates}
            />
          </span>
        </div>
      ) : null}
    </Block>
  );
}
