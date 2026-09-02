import type { Decimal } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { peekOpenState, peekPath } from '@scani/ui/v3/lib/peek';
import { CalendarClock } from 'lucide-react';
import { useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { type BaseCurrencyRates, useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { trpc } from '@/lib/trpc';
import { historyEstimatesByPaymentId } from '../../lib/forecast';
import { formatDueIn, nextPayments } from '../../lib/home';
import {
  type EstimatedOccurrenceTotals,
  estimatedTotals,
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
import { RunwayLine } from './RunwayLine';

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

/**
 * One aggregate at the foot of the block, and what it leaves out (SC-818).
 *
 * Exported and pure for the reason `<VaultProgressRow>` is: the block itself
 * owns three tRPC queries and cannot be rendered without a client, so a claim
 * made only inside it is a claim no test can reach. SC-797 is a defect that
 * shipped precisely because a second render site was invisible to a green
 * suite, and an exclusion line is exactly the kind of thing that reaches one
 * site and not the other.
 *
 * Both foot-lines take the same shape because they have the same defect:
 * `occurrenceTotals` resolves an occurrence priced from its own settled
 * history to `'0'`, so that money is in neither figure and — until this line —
 * nowhere on the screen either. The figure is deliberately NOT widened to
 * absorb it, which is SC-807's ruling: a total can carry no
 * `<EstimatedFromHistory>` mark to say which part of it was guessed.
 *
 * `exclusionKey` rather than a variant, because the two lines are different
 * CLAIMS and not two lengths of one — the overdue figure says what is already
 * late, the income figure says what somebody else is expected to send. The
 * same reasoning that kept `estimatedExcludedOverdue` off the committed
 * headline in `<UpcomingFeed>`.
 */
export function UpcomingFootLine({
  label,
  totals,
  estimated,
  exclusionKey,
  tokenSymbolById,
  rates,
  delta = false,
}: {
  label: string;
  totals: Map<string, Decimal>;
  estimated: EstimatedOccurrenceTotals;
  /** The sentence naming what this figure leaves out, as an i18n key. */
  exclusionKey: string;
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
  delta?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-border px-4 py-3">
      {/* `flex-wrap` and no `whitespace-nowrap` (SC-71 9.2): the healthy state
          is one clean figure and fits, but the degraded one carries a tail, and
          a row that cannot wrap loses the end of it behind the card edge rather
          than dropping to a second line. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-caption text-muted-foreground">{label}</span>
        <span className="text-label">
          <ConvertedFigure
            delta={delta}
            totals={totals}
            tokenSymbolById={tokenSymbolById}
            rates={rates}
          />
        </span>
      </div>

      {/* Conditional, and the asymmetry is the point (SC-807): with nothing
          estimated there is nothing excluded, and a permanent line reading
          €0.00 would assert a category most books never have.

          A `<span className="block">` rather than a `<p>`: `<ConvertedFigure>`
          renders a `<div>` skeleton while the rates are in flight, and the HTML
          parser closes a `<p>` at a `<div>` — a hydration mismatch rather than
          a style problem. */}
      {estimated.count > 0 ? (
        <span className="block text-caption text-muted-foreground">
          {/* One key for the whole sentence with the figure as a slot
              (SC-201/SC-235): the verb, the amount and the reason come in an
              order several of these languages do not share. */}
          <Trans
            i18nKey={exclusionKey}
            count={estimated.count}
            components={{
              amounts: (
                <ConvertedFigure
                  totals={estimated.totals}
                  tokenSymbolById={tokenSymbolById}
                  rates={rates}
                />
              ),
            }}
          />
        </span>
      ) : null}
    </div>
  );
}

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
  // SC-818, and it costs no round trip: `<RunwayLine>` at the foot of this same
  // block already issues `payments.forecast`, and react-query dedupes the two
  // onto one cache entry — the same entry the Money tab reads. That is also
  // what makes the exclusion figure here and the one on the Money tab the same
  // number by construction rather than by two derivations agreeing.
  const forecast = trpc.payments.forecast.useQuery();
  const historyEstimates = useMemo(
    () => historyEstimatesByPaymentId(forecast.data?.estimatedFromHistory ?? []),
    [forecast.data?.estimatedFromHistory]
  );

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

  // The other half of each figure, over exactly the same set (SC-818). An
  // occurrence priced from its own settled history contributes `'0'` to the
  // aggregate beside it, so until these lines that money appeared nowhere on
  // the home screen at all.
  const estimatedOverdue = estimatedTotals(overdue, historyEstimates);
  const estimatedIncome = estimatedTotals(income, historyEstimates);

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
      {overdue.length > 0 ? (
        <UpcomingFootLine
          label={t('v3.money.upcoming.overdueTotal', { count: overdue.length })}
          totals={overdueTotals}
          estimated={estimatedOverdue}
          // The Money tab's overdue tile says this, and this line makes the
          // same claim about the same set: bills already late, priced from a
          // settlement rather than declared. SC-807 kept the COMMITTED
          // headline's sentence off that tile because the two figures assert
          // different things; here the two figures assert the same thing, and a
          // second key with one meaning is a drift hazard — the day one is
          // retranslated the home screen and the Money tab state different
          // facts about the same bills.
          exclusionKey="v3.money.upcoming.estimatedExcludedOverdue"
          tokenSymbolById={tokenSymbolById}
          rates={rates}
        />
      ) : null}

      {income.length > 0 ? (
        <UpcomingFootLine
          delta
          label={t('v3.home.upcoming.incomeExpected', { count: INCOME_HORIZON_DAYS })}
          totals={incomeTotals}
          estimated={estimatedIncome}
          // Neither of the other two sentences fits a forecast. "An estimate is
          // not a commitment" is false by category — nothing on an income
          // figure is owed by the reader — and "its real amount is still
          // unknown" is a statement about lateness that no income row makes.
          // Shared with `<ExpectedIncome>` on the Money tab, which prints the
          // same figure over the same 90-day set from the same query.
          exclusionKey="v3.money.expectedIncome.estimatedExcluded"
          tokenSymbolById={tokenSymbolById}
          rates={rates}
        />
      ) : null}

      {/* Last, and below both measured foot-lines: the two above are sums of
          dated instances, this is a claim about the future. Its own rule is
          dashed for that reason — see `RunwayLine` (SC-461). */}
      <RunwayLine />
    </Block>
  );
}
