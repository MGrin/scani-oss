import { Button } from '@scani/ui/ui/button';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { trpc } from '@/lib/trpc';
import { RecurringList } from '../components/money/RecurringList';
import { UpcomingFeed } from '../components/money/UpcomingFeed';
import { VendorList } from '../components/money/VendorList';
import {
  INCOME_HORIZON_DAYS,
  MONEY_SEGMENTS,
  type MoneySegment,
  moneySegmentPath,
  resolveMoneySegment,
} from '../lib/money';
import { V3_PAYMENT_ROUTES } from '../lib/routes';

/**
 * The Money tab — §2.1's fourth slot, and three views of one question.
 *
 * **Upcoming leads** because a bill has a deadline and a standing list does
 * not. v2 opened the same section on a due-date feed too, but reached the other
 * two through separate sidebar entries; here they are a segmented control, so
 * the reader can see that the other two views exist without having to open a
 * drawer to find out.
 *
 * The segments are routes, not state (see `lib/money.ts`): the drawer and the
 * sidebar already point at `/v3/payments/recurring` and `/v3/vendors`, and each
 * view's peek sheet needs a URL of its own underneath it anyway.
 *
 * All five queries are issued on every segment. They are small, already shared
 * with the home screen's own upcoming block, and react-query dedupes them — so
 * moving between segments is instant rather than a fresh skeleton each time,
 * which is the whole reason to make this one surface instead of three pages.
 */

export function MoneyPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const segment = resolveMoneySegment(pathname);
  const [creatingVendor, setCreatingVendor] = useState(false);

  // The longer of the two windows (V3-47): bills are read from the first thirty
  // days of it and income from all ninety, so one cache entry serves both this
  // surface and the home screen's block.
  const upcoming = trpc.payments.upcoming.useQuery({ days: INCOME_HORIZON_DAYS });
  const payments = trpc.payments.list.useQuery();
  const vendors = trpc.vendors.list.useQuery();
  const tokens = trpc.tokens.getAll.useQuery();
  const vendorSpend = trpc.vendors.spend.useQuery();

  // One state per view, collapsed from the queries that view actually reads.
  // Before V3-16 each of these was an `||` chain over `isLoading` and the
  // error halves went nowhere: a 500 from `vendors.list` rendered `?? []` and
  // the surface invited the user to create the vendors they already had.
  const upcomingState = mergeQueries(upcoming, vendors, tokens);
  const recurringState = mergeQueries(payments, vendors, tokens);
  const vendorsState = mergeQueries(vendors, payments, tokens, vendorSpend);

  const vendorNameById = new Map(
    (vendors.data ?? []).map((vendor) => [vendor.id, vendor.displayName])
  );
  const tokenSymbolById = new Map((tokens.data ?? []).map((token) => [token.id, token.symbol]));
  // One rate query for the whole tab: the totals and the per-row equivalents on
  // both views draw on the same currencies, and the three view components stay
  // free of tRPC so they remain renderable — and assertable — on their own.
  const rates = useBaseCurrencyRates([
    ...(upcoming.data ?? []).map((occurrence) => occurrence.payment.currencyTokenId),
    ...(payments.data ?? []).map((payment) => payment.currencyTokenId),
    // Settled history can name a currency no *active* payment does any more —
    // an ended GBP subscription still has to convert in the paid totals.
    ...(vendorSpend.data?.totals ?? []).map((total) => total.currencyTokenId),
  ]);

  const changeSegment = (next: string) => {
    setCreatingVendor(false);
    navigate(moneySegmentPath(next as MoneySegment));
  };

  return (
    // `wide`, because two of the three views render a table above `lg` and a
    // five-column table inside a phone-width column is the horizontal scroll v3
    // exists to delete. On a phone the measure never binds.
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.money.page.title')}
        action={
          segment === 'vendors' ? (
            <Button variant="outline" onClick={() => setCreatingVendor(true)}>
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('v3.money.page.newVendor')}
            </Button>
          ) : (
            <Button asChild>
              <Link to={V3_PAYMENT_ROUTES.create}>
                <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {t('v3.money.page.addPayment')}
              </Link>
            </Button>
          )
        }
      />

      <Segmented
        value={segment}
        onValueChange={changeSegment}
        aria-label={t('v3.money.page.viewSwitcher')}
      >
        {MONEY_SEGMENTS.map((entry) => (
          <SegmentedItem key={entry.key} value={entry.key}>
            {t(entry.labelKey)}
          </SegmentedItem>
        ))}
      </Segmented>

      {segment === 'upcoming' ? (
        <UpcomingFeed
          occurrences={upcoming.data ?? []}
          paymentCount={(payments.data ?? []).length}
          vendorNameById={vendorNameById}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
          query={upcomingState}
        />
      ) : null}

      {segment === 'recurring' ? (
        <RecurringList
          payments={payments.data ?? []}
          vendorNameById={vendorNameById}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
          query={recurringState}
        />
      ) : null}

      {segment === 'vendors' ? (
        <VendorList
          vendors={vendors.data ?? []}
          payments={payments.data ?? []}
          spend={vendorSpend.data ?? null}
          tokenSymbolById={tokenSymbolById}
          rates={rates}
          query={vendorsState}
          creating={creatingVendor}
          onCreatingChange={setCreatingVendor}
        />
      ) : null}
    </PageLayout>
  );
}
