import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { DashboardGrid, DashboardItem, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { useReviewFeed } from '@/v2/hooks/useReviewFeed';
import { useOpenCapture } from '../components/capture/CaptureSheetContext';
import { StaleNotice } from '../components/feedback/StaleNotice';
import { AllocationBlock } from '../components/home/AllocationBlock';
import { AttentionRow } from '../components/home/AttentionRow';
import { GroupsBlock } from '../components/home/GroupsBlock';
import { HeroBlock } from '../components/home/HeroBlock';
import { TopHoldingsBlock } from '../components/home/TopHoldingsBlock';
import { UpcomingBlock } from '../components/home/UpcomingBlock';
import { VaultsBlock } from '../components/home/VaultsBlock';
import {
  DEFAULT_HOME_PERIOD,
  HOME_PERIOD_KEYS,
  homePeriodByKey,
  homePeriodRange,
} from '../lib/home';
import { readViewPreference, VIEW_PREFERENCE_KEYS } from '../lib/view-preference';

/**
 * The v3 home screen — what it contains. How wide it is belongs to
 * `PageLayout` (V3-37), and this file sets no width of its own.
 *
 * V3-09 built it from the research brief's five blocks, which deliberately
 * showed less than v2's dashboard. The user's verdict was that the reduction
 * went past what he asked for: the only thing he wanted gone was the row of
 * entity-count cards. So the screen now carries everything v2's dashboard
 * carries — net worth *and* PnL, allocation with its four cuts, top holdings,
 * groups, vaults, what is due — on v3's primitives rather than v2's.
 *
 * What stays deleted is the counts: institutions, accounts and holdings as
 * three equal-weight figures beside the total. A count of institutions is not a
 * reason to open a finance app, and three tied figures next to the one that
 * matters is what makes v2's dashboard answer no question at a glance. The
 * counts are still on `dashboard.getOverview`; nothing here reads them except
 * the empty state, which needs to know whether the account is new.
 *
 * **Source order is the phone order** — `DashboardGrid` stacks in source order
 * below `lg` — and the phone gets every block. Nothing is desktop-only, because
 * the phone is the primary surface and "missing information" is the complaint
 * this ticket answers. What keeps six blocks from being an endless scroll is
 * that each one bounds itself: one chart behind a metric toggle rather than
 * two, one allocation behind a dimension toggle rather than four, and every
 * list capped with its remainder one tap away *inside* the block rather than
 * on a screen that does not exist yet.
 *
 * Each block owns its own queries and renders its own empty and error copy, so
 * a failing vault list cannot take the net worth down with it — and so the grid
 * can re-span any of them without reading their internals.
 */

/** The hero block and the allocation block at their real heights. Drawn only
 *  from the `skeleton` band of the ramp; the measure and the page padding are
 *  the caller's, so the placeholder occupies exactly the box the content will. */
function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-2 h-11 w-56" />
        <Skeleton className="mt-3 h-6 w-32" />
        <Skeleton className="mt-4 h-[200px] w-full" />
      </div>
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-4 h-2 w-full rounded-full" />
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-full" />
      </div>
    </div>
  );
}

/**
 * Asks for the net-worth series as soon as the screen exists, rather than when
 * the block that draws it does (SC-164).
 *
 * Everything below returns early until `dashboard.getOverview` answers, and
 * `getOverview` is the slowest query on the screen — a whole-portfolio
 * valuation pass, which is why `trpc-provider` already gives `dashboard.*` its
 * own HTTP batch so it cannot hold the others up. The early return put that
 * dependency back by a different route: on a cold boot the series was not
 * requested until the overview had landed, one full round trip later, and at
 * 400 ms RTT that is most of half a second on the first screen a returning
 * reader sees.
 *
 * A prefetch rather than a restructure: the two queries share a key, so when
 * `HeroBlock` mounts it finds this request in flight and joins it. Nothing
 * about what the screen renders, or when, changes — only when the asking
 * starts. The window comes from `homePeriodRange`, which is what makes the two
 * keys identical.
 */
function useNetWorthSeriesPrefetch(): void {
  const utils = trpc.useUtils();
  useEffect(() => {
    const period = homePeriodByKey(
      readViewPreference(VIEW_PREFERENCE_KEYS.homePeriod, DEFAULT_HOME_PERIOD.key, HOME_PERIOD_KEYS)
    );
    void utils.portfolio.getNetWorthSeries.prefetch({
      ...homePeriodRange(period),
      granularity: 'auto',
    });
  }, [utils]);
}

export function HomePage() {
  const overview = trpc.dashboard.getOverview.useQuery();
  const openCapture = useOpenCapture();
  const { count: reviewCount } = useReviewFeed();
  const loadingPhase = useDelayedLoading(overview.isLoading);
  useNetWorthSeriesPrefetch();

  const currency = overview.data?.portfolioValue.baseCurrency ?? 'USD';
  const total = overview.data?.portfolioValue.totalValue;

  // The hero is the screen: without `dashboard.getOverview` there is no net
  // worth to lead with, so its state governs the page. Every other query now
  // lives inside a block that degrades to its own copy, and none of them can
  // take the whole screen down.
  if (overview.isError && overview.data === undefined) {
    return (
      <PageLayout>
        <QueryError
          error={overview.error}
          subject="your portfolio"
          onRetry={() => void overview.refetch()}
        />
      </PageLayout>
    );
  }

  if (overview.data === undefined) {
    return (
      <PageLayout>
        {/* Nothing for 300ms. The home screen is the app's cold start *and*
            its most-revisited surface — on the second visit the overview is
            in cache and this renders nothing at all, which is the point. */}
        <LoadingRamp
          phase={loadingPhase}
          skeleton={<HomeSkeleton />}
          label="your portfolio"
          onRetry={() => void overview.refetch()}
        />
      </PageLayout>
    );
  }

  // Genuinely empty, not filtered-empty: this is the first screen of a new
  // account, so it is the onboarding, and it carries the one action that ends
  // it rather than the word "None".
  if (overview.data.counts.holdings === 0) {
    return (
      <PageLayout className="items-start">
        <div className="flex flex-col gap-1">
          <h1 className="text-title">Nothing tracked yet</h1>
          <p className="text-body text-muted-foreground">
            Connect an exchange, import a file or add a holding by hand, and your net worth shows up
            here.
          </p>
        </div>
        {/* The capture sheet rather than a link: this screen names three ways
            in, and the sheet is the thing that lists all of them. */}
        <Button onClick={openCapture}>Add your first holding</Button>
        {/* The empty screen is exactly where a dead job hides best, and this
            branch used to return before the attention row (SC-153). Someone
            whose first import failed has no holdings *because* it failed —
            and was told "nothing tracked yet", which reads as "you have not
            tried". The row below it is the only thing on the screen that
            knows otherwise. */}
        {reviewCount > 0 ? <AttentionRow count={reviewCount} className="w-full" /> : null}
      </PageLayout>
    );
  }

  return (
    <DashboardGrid>
      {/* Above everything, because it qualifies everything: with the api
          unreachable this screen renders a full portfolio to the cent off the
          cache and used to say nothing at all about how old it was (SC-71 9.1).
          `overview` is the query the net worth, the totals and the top
          holdings all come from, so its state is the honest one to report. */}
      {overview.isError ? (
        <DashboardItem span="full">
          <StaleNotice onRetry={() => void overview.refetch()} />
        </DashboardItem>
      ) : null}

      {/* The hero takes the full row rather than sharing it. It is the one
          block the screen exists for, and its chart is the only element here
          that turns width directly into resolution — a wider trace is a longer
          readable history, not just a bigger picture. */}
      <DashboardItem span="full">
        <HeroBlock total={total} currency={currency} />
      </DashboardItem>

      {/* Full width because it is an alert: a row that has to be noticed
          cannot be the narrow one in a row of three. */}
      {reviewCount > 0 ? (
        <DashboardItem span="full">
          <AttentionRow count={reviewCount} />
        </DashboardItem>
      ) : null}

      {/* Three columns of standing facts. None is worth a full row alone, and
          putting them on one line is what keeps six blocks from becoming six
          screens on a desktop. On a phone they are the same three blocks in the
          same order, stacked. */}
      <DashboardItem span="third">
        <AllocationBlock />
      </DashboardItem>

      {/* Ahead of top holdings, as on v2: what is due is time-sensitive in a
          way a holdings ranking is not, so it takes the earlier slot. */}
      <DashboardItem span="third">
        <UpcomingBlock currency={currency} />
      </DashboardItem>

      <DashboardItem span="third">
        <TopHoldingsBlock holdings={overview.data.topHoldings} total={total} currency={currency} />
      </DashboardItem>

      {/* Halves rather than thirds: both carry a name beside a figure and a
          second line beneath it, and at a third of 1440 the name is what gives
          way.

          Both blocks render nothing when the user has none, so a portfolio
          without groups or vaults keeps the shorter screen it has today —
          `empty:hidden` is what collapses the placement wrapper with them,
          since an item left holding no child still spends six columns and a
          `gap-6` on nothing. CSS rather than lifting the queries up here: the
          page has no business knowing what makes a vault list empty. */}
      <DashboardItem span="half" className="empty:hidden">
        <GroupsBlock />
      </DashboardItem>

      <DashboardItem span="half" className="empty:hidden">
        <VaultsBlock />
      </DashboardItem>
    </DashboardGrid>
  );
}
