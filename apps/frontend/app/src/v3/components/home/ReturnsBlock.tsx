import { formatDate } from '@scani/shared';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { useViewPreference } from '../../hooks/useViewPreference';
import {
  BENCHMARK_LABEL_KEYS,
  offeredReturnsWindows,
  RETURNS_WINDOW_KEYS,
  type ReturnsMoney,
  type ReturnsView,
  type ReturnsWindow,
  type ReturnsWindowRequest,
  returnsView,
} from '../../lib/returns';
import { type ComparisonView, comparisonView } from '../../lib/returns-comparison';
import { VIEW_PREFERENCE_KEYS } from '../../lib/view-preference';
import { AttributionBar } from './AttributionBar';
import { ReturnsComparisonChart } from './ReturnsComparisonChart';
import { ReturnsHeadline } from './ReturnsHeadline';
import { ReturnsSubsetNote } from './ReturnsSubsetNote';

/** Omitted = the whole portfolio. */
export type ReturnsCardScope = { kind: 'account' | 'institution'; id: string };

export function ReturnsBlock({
  scope,
  heroWindow = null,
}: {
  scope?: ReturnsCardScope;
  /**
   * Non-null while the home chart's Returns tab is on (SC-1301): the window
   * the hero is measuring, which this card then shares rather than picking its
   * own. The hero also takes the figure and the chart, so what is left here is
   * the attribution bar and the ahead/behind rows — a table, which is a
   * different reading rhythm from a chart inside a hero.
   *
   * A custom RANGE since SC-1305, not one of the three named windows: the
   * hero's period control decides which days are measured, and mapping them
   * onto the nearest named window is what made 1M, 3M and 6M identical.
   */
  heroWindow?: ReturnsWindowRequest | null;
} = {}) {
  const [ownWindow, setOwnWindow] = useViewPreference<ReturnsWindow>(
    VIEW_PREFERENCE_KEYS.homeReturnsWindow,
    'ytd',
    RETURNS_WINDOW_KEYS
  );
  // One control, not two. While the tab is on, the chart's range drives both —
  // and because the window IS the query key, the hero and this card then share
  // one request rather than asking the same procedure two different questions.
  // All is offered only when it starts earlier than 1Y (SC-1439), which takes
  // both windows' resolved starts. The query for the chosen window is the same
  // key, so choosing either of them costs no second request.
  const ownProbe = trpc.portfolio.hasReturns.useQuery({ window: { kind: ownWindow }, scope });
  const canCompare = heroWindow === null && ownProbe.data?.hasReturns === true;
  const allStart = trpc.portfolio.getReturns.useQuery(
    { window: { kind: 'all' }, scope },
    { enabled: canCompare }
  );
  const yearStart = trpc.portfolio.getReturns.useQuery(
    { window: { kind: '1y' }, scope },
    { enabled: canCompare }
  );
  const windows = offeredReturnsWindows(
    allStart.data?.returns?.effectiveWindow?.from,
    yearStart.data?.returns?.effectiveWindow?.from
  );
  const allWithheld =
    allStart.isSuccess && yearStart.isSuccess && !windows.some((w) => w.key === 'all');
  // A saved All that is not offered reads as 1Y, which is the same window.
  const shownWindow: ReturnsWindow = ownWindow === 'all' && allWithheld ? '1y' : ownWindow;
  const request: ReturnsWindowRequest = heroWindow ?? { kind: shownWindow };
  const { symbol } = useBaseCurrency();
  const historyQuery = trpc.portfolio.hasReturns.useQuery({ window: request, scope });
  const hasHistory = historyQuery.data?.hasReturns === true;
  const query = trpc.portfolio.getReturns.useQuery(
    { window: request, scope },
    { enabled: hasHistory }
  );
  const view = returnsView(query.data?.returns, query.data?.benchmarks);

  const comparisonQuery = trpc.portfolio.getReturnsComparison.useQuery(
    { window: request },
    // The whole-portfolio card is the only one that draws it, and asking for
    // prices behind a card that will not render them is the expensive half of
    // this feature paid for nothing.
    {
      enabled:
        scope === undefined && hasHistory && query.data?.returns?.eligibility?.eligible === true,
    }
  );
  const comparison = comparisonView(comparisonQuery.data, view?.benchmarks);

  // Keep the card standing while another window loads, so the switch does not
  // collapse and re-grow the row it sits in. The probe counts as loading too:
  // without it a window change would collapse the card for one round trip
  // before `getReturns` is even enabled.
  if (!view && !query.isFetching && !historyQuery.isFetching) return null;

  return (
    <ReturnsCard
      view={view}
      comparison={scope ? null : comparison}
      comparisonFailed={scope === undefined && comparisonQuery.isError}
      currency={symbol}
      windowKey={shownWindow}
      windows={windows}
      onWindowChange={setOwnWindow}
      promotedToHero={heroWindow !== null}
    />
  );
}

export function ReturnsCard({
  view,
  comparison,
  comparisonFailed,
  currency,
  windowKey,
  windows = offeredReturnsWindows(null, null),
  onWindowChange,
  promotedToHero = false,
}: {
  view: ReturnsView | null;
  comparison: ComparisonView | null;
  comparisonFailed: boolean;
  currency: string;
  windowKey: ReturnsWindow;
  /** The periods the picker offers; All only when it covers more than 1Y. */
  windows?: readonly { key: ReturnsWindow; labelKey: string }[];
  onWindowChange: (key: string) => void;
  /**
   * The home chart's Returns tab is on, so the money figure, the chart and the
   * window control are all up in the hero (SC-1301).
   *
   * **The money figure is the one that matters.** Chart-and-figure up top with
   * the rows left below puts the same number within reach of two code paths on
   * one screen; two copies of one number, updated by two paths, eventually
   * disagree. `returnsTab.test.tsx` counts it on the assembled screen and
   * fails at two. SC-1305 changed the hero's SHAPE from a sentence to a tile
   * and left that hazard exactly where it was, so the guard was re-aimed at
   * the figure rather than at the wording.
   */
  promotedToHero?: boolean;
}) {
  const { t } = useTranslation();
  const money = view?.money ?? null;

  return (
    <Block>
      <BlockHeader title={t('v3.home.returns.title')} />
      {promotedToHero ? null : (
        <div className="px-4 pb-3">
          <Segmented
            value={windowKey}
            onValueChange={onWindowChange}
            aria-label={t('v3.home.returns.chooseWindow')}
          >
            {windows.map((option) => (
              <SegmentedItem key={option.key} value={option.key}>
                {t(option.labelKey)}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
      )}
      {view ? (
        <>
          {view.unavailableReasons ? (
            <div className="px-4 pb-3 text-caption text-muted-foreground">
              <p>{t('v3.home.returns.unavailable')}</p>
              <ul>
                {view.unavailableReasons.map((reason) => (
                  <li key={reason}>{t(`v3.home.returns.eligibility.${reason}`)}</li>
                ))}
              </ul>
              {view.recordedChange != null ? (
                <p>
                  {t('v3.home.returns.recordedChange')}{' '}
                  <Numeric value={view.recordedChange} currency={currency} delta />
                </p>
              ) : null}
            </div>
          ) : null}
          {money && !promotedToHero ? (
            <ReturnsHeadline money={money} currency={currency} className="px-4 pb-3" />
          ) : null}
          {/* Directly under the figure it qualifies: a caveat at the foot of
              the card is one nobody reads (SC-1439). */}
          {view.subset && view.subset.excluded.length > 0 ? (
            <ReturnsSubsetNote
              subset={view.subset}
              currency={currency}
              brief
              className="block px-4 pb-3 text-caption text-muted-foreground"
            />
          ) : null}
          {money ? <AttributionBar money={money} currency={currency} /> : null}

          {promotedToHero ? null : comparison && comparison.points.length > 0 ? (
            <ReturnsComparisonChart comparison={comparison} currency={currency} />
          ) : comparisonFailed ? (
            // One line of plain text, not an empty frame: the figures above it
            // are unaffected and the reader should be told that in words.
            <p className="border-t border-border px-4 py-3 text-caption text-muted-foreground">
              {t('v3.home.returns.chart.unavailable')}
            </p>
          ) : null}

          {comparison && comparison.gaps.length > 0 ? (
            <Gaps gaps={comparison.gaps} currency={currency} />
          ) : null}

          <Details view={view} money={money} />

          {view.subset ? (
            <ReturnsSubsetNote
              subset={view.subset}
              currency={currency}
              coveredAbove
              className="border-t border-border px-4 py-3 text-caption text-muted-foreground"
            />
          ) : null}

          {view.since || view.partial ? (
            <p className="border-t border-border px-4 py-3 text-caption text-muted-foreground">
              {view.since && !money
                ? t('v3.home.returns.since', { date: formatDate(view.since) })
                : null}
              {view.since && !money && view.partial ? ' ' : null}
              {view.partial ? t('v3.home.returns.partial') : null}
            </p>
          ) : null}
        </>
      ) : null}
    </Block>
  );
}

/**
 * Ahead or behind each benchmark, the money first.
 *
 * The row's value is the GAP — what the reader has against what the same
 * deposits and withdrawals would have come to in that benchmark — which is the
 * comparison the card exists to make. The benchmark's own return, which used
 * to be the whole row, is the caption: still there, no longer the headline.
 */
function Gaps({ gaps, currency }: { gaps: ComparisonView['gaps']; currency: string }) {
  const { t } = useTranslation();
  return (
    <div className="border-t border-border px-4 py-3">
      <p className="text-label">{t('v3.home.returns.gaps.label')}</p>
      <p className="text-caption text-muted-foreground">{t('v3.home.returns.gaps.caption')}</p>
      <dl className="mt-2 flex max-w-[34rem] flex-col gap-2">
        {gaps.map((gap) => (
          <div
            key={gap.key}
            data-figure-line="true"
            className="flex items-baseline justify-between gap-3"
          >
            <dt className="min-w-0 flex-1 text-label">
              {t('v3.home.returns.gaps.vs', { name: t(BENCHMARK_LABEL_KEYS[gap.key]) })}
            </dt>
            {/* Each figure names what it measures (SC-1430). A signed gap
                beside the benchmark's own signed return read as one
                contradiction: "↑ +£5,000" over "−5.0%". */}
            <dd className="max-w-[60%] shrink-0 text-end">
              <span className="block text-label">
                <Trans
                  i18nKey={
                    gap.money >= 0 ? 'v3.home.returns.gaps.ahead' : 'v3.home.returns.gaps.behind'
                  }
                  components={{
                    amount: (
                      <Numeric
                        value={Math.abs(gap.money)}
                        currency={currency}
                        className={gap.money >= 0 ? 'text-gain' : 'text-loss'}
                      />
                    ),
                  }}
                />
              </span>
              {gap.cumulative === null ? null : (
                <span className="block text-caption text-muted-foreground">
                  <Trans
                    i18nKey="v3.home.returns.gaps.returned"
                    components={{
                      value: <Numeric value={gap.cumulative} format="percent" decimals={1} />,
                    }}
                  />
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The rates, kept and demoted.
 *
 * `<details>` rather than an accordion, because
 * Radix unmounts its content, so a closed disclosure removes the numbers from
 * the document and neither find-in-page nor a `renderToStaticMarkup` test can
 * reach them. Closed by default — an open one has put the rates back above the
 * money while looking as though it had not.
 */
function Details({ view, money }: { view: ReturnsView; money: ReturnsMoney | null }) {
  const { t } = useTranslation();
  return (
    <details className="group border-t border-border px-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-caption text-muted-foreground transition-colors duration-fast ease-emphasized hover:text-foreground [&::-webkit-details-marker]:hidden">
        {t('v3.home.returns.details')}
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 transition-transform duration-base ease-emphasized group-open:rotate-180"
        />
      </summary>
      <dl className="flex flex-col divide-y divide-border border-t border-border">
        <ReturnRow
          label={t('v3.home.returns.twr.label')}
          caption={t('v3.home.returns.twr.caption')}
          value={view.twr?.cumulative ?? null}
          note={
            view.twr?.annualized != null ? (
              <Trans
                i18nKey="v3.home.returns.perYear"
                components={{
                  value: <Numeric value={view.twr.annualized} format="percent" decimals={1} />,
                }}
              />
            ) : null
          }
        />
        {view.fx ? (
          <ReturnRow
            label={t('v3.home.returns.fx.label')}
            caption={
              <Trans
                i18nKey="v3.home.returns.fx.caption"
                components={{
                  value: <Numeric value={view.fx.asset} format="percent" decimals={1} delta />,
                }}
              />
            }
            value={view.fx.currency}
            note={null}
          />
        ) : null}
        <ReturnRow
          label={t('v3.home.returns.xirr.label')}
          caption={
            view.xirr?.approximate
              ? t('v3.home.returns.xirr.approximate')
              : t('v3.home.returns.xirr.caption')
          }
          value={view.xirr?.rate ?? null}
          note={view.xirr ? t('v3.home.returns.perYearUnit') : null}
        />
        {view.benchmarks.length > 0 ? (
          <div className="py-3">
            <p className="text-label">{t('v3.home.returns.benchmarks.label')}</p>
            <p className="text-caption text-muted-foreground">
              {t('v3.home.returns.benchmarks.caption')}
            </p>
            <dl className="mt-2 flex flex-col gap-1">
              {view.benchmarks.map((benchmark) => (
                <div key={benchmark.key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-caption">{t(BENCHMARK_LABEL_KEYS[benchmark.key])}</dt>
                  <dd className="shrink-0">
                    <Numeric
                      value={benchmark.cumulative}
                      format="percent"
                      decimals={1}
                      delta
                      className="text-caption"
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        {/* The money sentence names the window's start, so this repeats it only
            where there is no money sentence to have named it. */}
        {view.since && money ? (
          <p className="py-3 text-caption text-muted-foreground">
            {t('v3.home.returns.since', { date: formatDate(view.since) })}
          </p>
        ) : null}
      </dl>
    </details>
  );
}

function ReturnRow({
  label,
  caption,
  value,
  note,
}: {
  label: string;
  caption: ReactNode;
  value: number | null;
  note: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <dt className="min-w-0">
        <span className="block text-label">{label}</span>
        <span className="block text-caption text-muted-foreground">{caption}</span>
      </dt>
      <dd className="shrink-0 text-end">
        {value === null ? (
          <span className="text-label text-muted-foreground">—</span>
        ) : (
          <Numeric value={value} format="percent" decimals={1} delta className="text-label" />
        )}
        {note ? <span className="block text-caption text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}
