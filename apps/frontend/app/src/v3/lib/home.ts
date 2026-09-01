import { ALLOCATION_OTHER_KEY, type AllocationInput } from '@scani/ui/v3/lib/chart';
import { toFiniteNumber } from '@scani/ui/v3/lib/numeric';
import type { TFunction } from 'i18next';
import { tokenDisplayName } from '@/lib/utils';
import { compareGroupAmounts, type GroupValue, groupAmount, groupValuesById } from './groups';
import { V3_ROUTES } from './routes';
import { tokenTypeLabel } from './tokens';

/**
 * The pure half of the v3 home screen — every decision the five blocks make
 * about the data behind them, kept out of the component so it can be tested
 * without a tRPC client.
 *
 * Three of these are load-bearing and none is obvious from its call site:
 *
 * - The delta and the sparkline are measured against the **live** total from
 *   `dashboard.getOverview`, not against the last point of the rollup series.
 *   The nightly rollup lands a day behind, so a home screen that showed a
 *   headline from one source and a change from another would report a delta
 *   the headline contradicts.
 * - The baseline is the **first point inside the window**, so "vs 30d" means
 *   what it says. A user whose history starts eight days ago gets no delta
 *   rather than a 30-day claim measured over eight.
 * - Upcoming payments are filtered to **due today or later**. `payments.upcoming`
 *   returns overdue occurrences too, and a block headed "Next" that opens with
 *   a bill from March is worse than an empty one.
 */

export interface HomePeriod {
  key: string;
  /** Segmented-control label, as an i18n key — this table is plain data and
   *  has no `t` (SC-201). */
  labelKey: string;
  /** Read after "vs" beneath the hero, also as a key. `1W` and `7d` are not
   *  universal abbreviations; a Japanese or Russian reader needs their own. */
  suffixKey: string;
  days: number;
}

export const HOME_PERIODS: readonly HomePeriod[] = [
  { key: '7d', labelKey: 'v3.home.period.label7d', suffixKey: 'v3.home.period.suffix7d', days: 7 },
  {
    key: '30d',
    labelKey: 'v3.home.period.label30d',
    suffixKey: 'v3.home.period.suffix30d',
    days: 30,
  },
  {
    key: '90d',
    labelKey: 'v3.home.period.label90d',
    suffixKey: 'v3.home.period.suffix90d',
    days: 90,
  },
  {
    key: '180d',
    labelKey: 'v3.home.period.label180d',
    suffixKey: 'v3.home.period.suffix180d',
    days: 180,
  },
  {
    key: '365d',
    labelKey: 'v3.home.period.label365d',
    suffixKey: 'v3.home.period.suffix365d',
    days: 365,
  },
];

export const DEFAULT_HOME_PERIOD = HOME_PERIODS[1] as HomePeriod;

export function homePeriodByKey(key: string): HomePeriod {
  return HOME_PERIODS.find((period) => period.key === key) ?? DEFAULT_HOME_PERIOD;
}

/** The windows a persisted choice is checked against — see `useViewPreference`. */
export const HOME_PERIOD_KEYS: readonly string[] = HOME_PERIODS.map((period) => period.key);

const DAY_MS = 24 * 60 * 60 * 1000;

export function periodRange(period: HomePeriod, now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - period.days * DAY_MS), to: now };
}

/**
 * The home chart's window, resolved once per period per calendar day.
 *
 * `periodRange(period, new Date())` is a different pair of instants every time
 * it is called, and the pair is the query key. That had two costs. The visible
 * one is that **nothing could ask for the series before the block that renders
 * it existed** — a prefetch and the block's own `useQuery` would have computed
 * two keys milliseconds apart and issued two requests, so the series could not
 * start until `HeroBlock` mounted, which is after `dashboard.getOverview`
 * answers (SC-164). The quiet one is that the 30-second `staleTime` never
 * applied to this query at all: leaving the home screen and coming back
 * produced a new key and a new round trip, every time.
 *
 * Anchoring to the day keeps the property `HeroBlock` wanted — the window is
 * pinned to the period rather than to the clock, so a refetch cannot shift the
 * baseline out from under the delta on screen — and extends it from "per mount"
 * to "per day", which is the granularity the series is stored at anyway.
 */
const HOME_RANGES = new Map<string, { from: Date; to: Date }>();

export function homePeriodRange(
  period: HomePeriod,
  now: Date = new Date()
): {
  from: Date;
  to: Date;
} {
  const key = `${period.key}@${now.toISOString().slice(0, 10)}`;
  const cached = HOME_RANGES.get(key);
  if (cached) return cached;
  const range = periodRange(period, now);
  HOME_RANGES.set(key, range);
  return range;
}

/**
 * The two things the hero chart can show. A segmented control rather than two
 * stacked charts: they answer the same question — *what changed* — in two
 * currencies of meaning, and a phone that shows both at once shows neither.
 * v2 made the same call with a pair of tabs.
 */
export type HomeMetric = 'net-worth' | 'pnl';

export const HOME_METRICS: readonly { key: HomeMetric; labelKey: string }[] = [
  { key: 'net-worth', labelKey: 'v3.home.metric.netWorth' },
  { key: 'pnl', labelKey: 'v3.home.metric.pnl' },
];

export const HOME_METRIC_KEYS: readonly HomeMetric[] = HOME_METRICS.map((metric) => metric.key);

/**
 * How much of a rolled-up day we could actually price.
 *
 * Every series row carries it, and every reader of a series has to consult it
 * before treating `totalValue` as a figure: the rollup writes `0` for a day it
 * priced nothing on, which is indistinguishable from a portfolio genuinely
 * worth nothing unless you look here.
 */
export interface CoveragePoint {
  holdingsWithKnownValue: number;
  holdingsTotal: number;
}

/**
 * Whether a day's total is a measurement at all.
 *
 * Zero holdings priced means the day's `totalValue` of 0 is the absence of an
 * answer, not the answer zero — plotting it drew a plunge to €0 and a spike
 * back out of two days that were nothing of the kind, and any delta measured
 * against it claimed the user had lost everything and got it back. A day where
 * the holdings existed and were each worth 0 is a real zero and stays.
 */
function hasKnownCoverage(point: CoveragePoint): boolean {
  return point.holdingsWithKnownValue > 0;
}

/**
 * The counts that qualify a figure the reader is already looking at, on top of
 * the two that say whether it is a measurement at all.
 *
 * Three axes, and collapsing any pair of them loses the fact the reader needs:
 *
 * - `holdingsUnpriceable` is out of coverage's **denominator** (SC-146).
 *   Nothing quotes these — airdropped or delisted tokens with no market — so
 *   counting them as failures reported a fully-priced portfolio as 80% covered.
 * - `holdingsStalePriced` is inside the numerator (SC-151). An old price is
 *   still a measurement, so a day can be 100% priced and still be built on
 *   quotes weeks old; that is a different question from how much was priced,
 *   not a worse grade of it.
 * - `holdingsBasisUnknown` qualifies the *gain*, not the value (SC-149), which
 *   is why it never degrades coverage: folding it in would mark the net-worth
 *   chart down for a PnL reason.
 * - `transfersUnreviewed` qualifies the gain too, and is the only one of the
 *   four that runs DOWNWARD (SC-160). An unanswered withdrawal books no gain
 *   at all, so where one is a real off-platform sale the realized figure is
 *   short by it. It is also the only one a reader can act on, which is why it
 *   renders as a link rather than as another clause of prose.
 */
export interface QualityPoint extends CoveragePoint {
  holdingsUnpriceable: number;
  holdingsStalePriced: number;
  holdingsBasisUnknown: number;
  /**
   * Optional because the net-worth series genuinely does not carry it: it
   * qualifies realized PnL, and `NetWorthHistoryRow` — the shape the
   * net-worth series and both exports share — deliberately omits it rather
   * than ship a column explaining a figure that file does not contain.
   *
   * The risk of an optional count is the one SC-151 paid for: a signal that
   * silently reads as zero reaches nobody and looks like good news.
   * `tests/v3/lib/home.test.ts` pins the PnL point's shape against
   * `summariseQuality` so a dropped field fails a test rather than a reader.
   */
  transfersUnreviewed?: number;
}

/**
 * How much of a figure is a measurement, and what was set aside to say so —
 * `null` when the day has nothing priceable in it and the question has no
 * answer.
 *
 * `includeBasis` is the metric asking, not a preference. Cost basis says
 * nothing about a net-worth figure, and SC-149's whole point is that it must
 * not be allowed to.
 */
export interface FigureQuality {
  /** Of the holdings something *could* price, how many carried a price. */
  priced: number;
  /** `holdingsTotal − holdingsUnpriceable` — the honest denominator. */
  priceable: number;
  /** Floored, so 299 of 300 reads as 99% rather than rounding up to a full house. */
  percent: number;
  complete: boolean;
  unpriceable: number;
  stalePriced: number;
  /** Zero unless the figure being qualified is a PnL. */
  basisUnknown: number;
  /** Zero unless the figure being qualified is a PnL — same gate, same reason:
   *  an unanswered withdrawal says nothing about what the portfolio is worth,
   *  only about what it realized on the way here (SC-160). */
  transfersUnreviewed: number;
}

export function summariseQuality(
  point: QualityPoint | null | undefined,
  options: { includeBasis: boolean }
): FigureQuality | null {
  if (!point) return null;
  const priceable = point.holdingsTotal - point.holdingsUnpriceable;
  if (priceable <= 0) return null;
  // A count above its own denominator would render as "104% priced", which is
  // a worse thing to show a reader than a clamped 100.
  const priced = Math.min(point.holdingsWithKnownValue, priceable);
  return {
    priced,
    priceable,
    percent: Math.floor((priced / priceable) * 100),
    complete: priced >= priceable,
    unpriceable: point.holdingsUnpriceable,
    stalePriced: point.holdingsStalePriced,
    basisUnknown: options.includeBasis ? point.holdingsBasisUnknown : 0,
    transfersUnreviewed: options.includeBasis ? (point.transfersUnreviewed ?? 0) : 0,
  };
}

/**
 * The fraction, in words — the half of the question mgrin asked that nothing in
 * v3 answered: *how much of this figure is real*.
 *
 * A percentage **and** the counts behind it. The percentage is what a glance
 * takes, and it is the form the question was asked in; the counts are what
 * makes it checkable — "28 of 30 holdings" can be held against the holdings
 * list and "93%" cannot.
 */
export function qualityHeadline(quality: FigureQuality, t: TFunction): string {
  const fraction = quality.complete
    ? t('v3.home.quality.allPriced', { count: quality.priceable })
    : t('v3.home.quality.partlyPriced', {
        percent: quality.percent,
        priced: quality.priced,
        priceable: quality.priceable,
      });
  // The unpriceable count belongs HERE, not in the omissions run below, because
  // it is the only one of the four that is about the *denominator*. Under it,
  // "All 12 holdings priced" was followed a line later by "2 unpriceable" and
  // read as a correction — a reader had to reconstruct that there were 14 and
  // that 2 of them are not quotable by anyone. Beside the fraction it defines,
  // it reads as the arithmetic it is (SC-176).
  return quality.unpriceable > 0
    ? t('v3.home.quality.withUnpriceable', { fraction, count: quality.unpriceable })
    : fraction;
}

/**
 * The other half: of the holdings that ARE counted, which ones stand on thin
 * ground.
 *
 * Each clause appears only when its count is non-zero, so the ordinary account
 * gets no run at all. Both bias the figure the same way — upward — which is why
 * silence here would not be neutral.
 *
 * **Every word here is paid for in vertical space** (SC-176). At 390px this run
 * had grown to four wrapped lines, more than the hero figure it qualifies,
 * and a qualifier that outweighs its figure reads as the content with the
 * number as its heading. The counts and their subjects are the information;
 * "left out of the count" and "with unknown" were not, so they went — but
 * "(the gain is an upper bound)" stayed, because the direction a figure errs
 * in is the one thing a reader cannot work out from a count. Both clauses now
 * fit one 390px line together, measured, and `CoverageNote` keeps each of them
 * unbreakable so a bigger account wraps between them and never mid-clause.
 *
 * The unpriceable count is deliberately absent — `qualityHeadline` carries it,
 * next to the denominator it explains.
 */
export function qualityOmissions(quality: FigureQuality, t: TFunction): string[] {
  const parts: string[] = [];
  if (quality.stalePriced > 0) {
    parts.push(t('v3.home.quality.staleQuotes', { count: quality.stalePriced }));
  }
  if (quality.basisUnknown > 0) {
    parts.push(t('v3.home.quality.noBasis', { count: quality.basisUnknown }));
  }
  return parts;
}

/**
 * The omission that runs the other way, and the only one with somewhere to go
 * (SC-160).
 *
 * SC-150 stopped realizing an unpaired withdrawal at market value, because a
 * missed pairing between two of the reader's own accounts was booking a gain
 * nobody made. The cost of that: an unanswered withdrawal that really was an
 * off-platform sale books nothing, so realized PnL is **short**. Every clause
 * in `qualityOmissions` says the figure may be too high; this one says it is
 * too low, which is why it is not folded in with them — a reader who takes
 * "these all flatter the number" from one line and then finds a clause that
 * does not has learned to distrust the whole note.
 *
 * "Excludes", not "may exclude". The exclusion is certain; only whether each
 * excluded row was a sale is not, and hedging a fact we are sure of to avoid
 * asserting one we are not makes the sentence false in the other direction.
 *
 * Returns the sentence without the destination — the caller renders the link,
 * because a string cannot carry one and the whole point of this clause is
 * that it is answerable.
 */
export function unreviewedTransfersNote(quality: FigureQuality, t: TFunction): string | null {
  const count = quality.transfersUnreviewed;
  if (count <= 0) return null;
  // "unconfirmed", not "you have not confirmed" — the same claim in 11 fewer
  // characters, which is the difference between one line and two at 390px. The
  // long form wrapped, and because the whole sentence is the tap target the
  // underline then ran across two lines with "confirmed" orphaned on the
  // second: a link that looks like two links (SC-176).
  return t('v3.home.quality.unreviewedTransfers', { count });
}

/**
 * The most recent day the series actually measured — the row whose coverage
 * describes the figure on screen.
 *
 * The user-wide series arrives already filtered to measured days, so this is
 * usually its last row; a scoped series is not, and taking the tail of one
 * would qualify the headline with a day nothing was priced on.
 */
export function latestMeasured<T extends CoveragePoint>(series: readonly T[]): T | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const row = series[index];
    if (row && hasKnownCoverage(row)) return row;
  }
  return null;
}

/** The subset of `portfolio.getNetWorthSeries`'s rows this screen reads. */
export interface NetWorthPoint extends CoveragePoint {
  date: string;
  totalValue: string;
}

export interface PeriodDelta {
  absolute: number;
  /** `null` when the baseline is zero — a change from nothing has no ratio. */
  percent: number | null;
}

/**
 * What the line under the hero figure is allowed to say — the four states kept
 * apart, and in this order.
 *
 * SC-71 9.1 established that a *failed* series is not an empty one: with the
 * api down the block printed "No history for this period yet" under a full net
 * worth figure, which is a network fault rendered as a statement about the
 * reader's data. SC-111 is the third member of that family and the worst-placed
 * one: a series still *loading* also has no delta, so the same sentence was
 * printed while the answer was on its way. On the iOS magic-link landing the
 * request took long enough for that to be the first thing a new user read —
 * "no history" on an account with a year of it, at the one moment they have no
 * way to know better. It shows on desktop too, for a frame, on every period
 * switch: the query key changes, the data goes, and the empty state fills the
 * gap.
 *
 * So loading outranks failed, which outranks empty, and only the last of the
 * three is a claim about the account.
 */
export type HeroDeltaState = 'delta' | 'loading' | 'failed' | 'empty';

export function heroDeltaState(input: {
  hasDelta: boolean;
  isLoading: boolean;
  hasFailed: boolean;
}): HeroDeltaState {
  if (input.hasDelta) return 'delta';
  if (input.isLoading) return 'loading';
  if (input.hasFailed) return 'failed';
  return 'empty';
}

/**
 * The change over the window, or `null` when the window has no baseline to
 * measure against. Null is a real answer here and renders as nothing: a "+0.00"
 * under the hero would claim the portfolio held still when what happened is
 * that we have no history yet.
 *
 * The baseline skips uncovered days — see `hasKnownCoverage`. A window that
 * opens on a day we priced nothing on has no baseline at its first point, and
 * measuring against the zero written there produced the headline "+100%" on a
 * portfolio that had not moved.
 */
export function resolvePeriodDelta(
  series: readonly NetWorthPoint[],
  currentTotal: number | string | null | undefined
): PeriodDelta | null {
  const covered = series.filter(hasKnownCoverage);
  const current = toFiniteNumber(currentTotal);
  const baseline = toFiniteNumber(covered[0]?.totalValue);
  if (current === null || baseline === null || covered.length < 2) return null;

  const absolute = current - baseline;
  return { absolute, percent: baseline === 0 ? null : (absolute / baseline) * 100 };
}

/**
 * The sparkline's points: the rollup series with the live total appended, so
 * the glyph ends where the hero does and its direction cannot disagree with
 * the delta printed beside it.
 *
 * Uncovered days are dropped rather than plotted at zero. A sparkline has no
 * date axis, so a dropped day costs nothing readable; a day drawn at zero costs
 * the whole shape.
 */
export function sparklineSeries(
  series: readonly NetWorthPoint[],
  currentTotal: number | string | null | undefined
): number[] {
  const points = series.flatMap((point) => {
    if (!hasKnownCoverage(point)) return [];
    const value = toFiniteNumber(point.totalValue);
    return value === null ? [] : [value];
  });
  const current = toFiniteNumber(currentTotal);
  return current === null ? points : [...points, current];
}

/**
 * One plotted point of the hero chart. `value` is already in base currency, and
 * is `null` on a day we priced nothing — the area chart draws those as a break
 * in the line (`connectNulls={false}`), which is what a day with no answer
 * looks like.
 */
export interface TrendPoint {
  date: string;
  value: number | null;
}

/**
 * The net-worth curve, ending on the **live** total rather than on the last
 * rolled-up night.
 *
 * Same rule as `sparklineSeries`, made explicit for a chart that has a date
 * axis: the rollup lands a day behind, so a curve that stopped at the last
 * rollup point would end below the figure printed above it, and the reader
 * would be looking at two numbers that disagree in the same block. When the
 * rollup has already produced today's row the live total *replaces* it rather
 * than appending a second point on the same date, which would draw a vertical
 * step at the right edge.
 *
 * A day we priced nothing on keeps its slot on the date axis and carries a
 * `null` value, so the curve breaks over it instead of diving to zero and
 * spiking back. Same for a total we cannot parse: the date is real, the figure
 * is not.
 *
 * `unmeasured` is how those days arrive now (SC-115). The user-wide series
 * stopped carrying them when SC-98 moved the coverage filter to the source, and
 * the axis here is a **category** axis — one slot per point — so a day the
 * server dropped is not a hole in the curve, it is a day the curve has never
 * heard of, and the line joins its neighbours straight across. On an account
 * whose rollup is a few days behind, that line runs from the last real
 * measurement to today's live total — a climb the reader never had, drawn
 * exactly like the measured ones beside it. Putting the dropped days back as
 * nulls costs nothing and restores the break.
 */
export function netWorthChartPoints(
  series: readonly NetWorthPoint[],
  currentTotal: number | string | null | undefined,
  today: string,
  unmeasured: readonly string[] = []
): TrendPoint[] {
  const measured = new Set(series.map((point) => point.date));
  const points = [
    ...series.map((point) => ({
      date: point.date,
      value: hasKnownCoverage(point) ? toFiniteNumber(point.totalValue) : null,
    })),
    // A date the server reports as unmeasured *and* returns a row for is one
    // row, not two — the scoped series still carries its uncovered days.
    ...unmeasured.filter((date) => !measured.has(date)).map((date) => ({ date, value: null })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const current = toFiniteNumber(currentTotal);
  if (current === null) return points;

  const last = points[points.length - 1];
  if (last && last.date === today) {
    return [...points.slice(0, -1), { date: today, value: current }];
  }
  return [...points, { date: today, value: current }];
}

/**
 * The last day we actually measured, when the days since then are a gap —
 * `null` when the curve runs up to today and there is nothing to explain.
 *
 * The other half of SC-115, and the half the ticket is really about. Breaking
 * the line stops the chart from *claiming* something false, but a reader still
 * cannot tell these three apart from the same picture: we have no measurement
 * for those days, the portfolio did not move, or the app has stopped working.
 * With today's figure printed in full directly above, the natural reading is
 * the third — "it knows what I am worth today, so why does the line stop?".
 * Only a sentence can settle that, so the block gets one.
 *
 * Today's own point is not evidence either way: it is the live total, appended
 * by `netWorthChartPoints`, and it is exactly the point whose provenance the
 * sentence has to explain.
 */
export function lastMeasuredBeforeToday(
  points: readonly TrendPoint[],
  today: string
): string | null {
  const rollup = points.filter((point) => point.date !== today);
  const lastKnownIndex = rollup.map((point) => point.value !== null).lastIndexOf(true);
  const lastKnown = rollup[lastKnownIndex];
  if (!lastKnown) return null;
  // A gap only counts if it reaches today. A break in the middle of the window
  // with measurements after it is visible on its own and needs no caption.
  const gapReachesToday = rollup.at(-1)?.value === null;
  return gapReachesToday ? lastKnown.date : null;
}

/** The subset of `portfolio.getPnLSeries`'s rows the hero chart reads. */
export interface PnLPoint extends QualityPoint {
  date: string;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
  totalPnl: string | null;
}

export interface PnLChartPoint {
  date: string;
  /** `null` where the rollup has not computed PnL for that day yet. */
  total: number | null;
  realized: number | null;
  unrealized: number | null;
}

/**
 * PnL re-based to the start of the window.
 *
 * The series carries PnL cumulative **since inception**, so plotted raw it
 * ignores the period selector entirely — 1W and 1Y would draw the same right
 * edge and differ only in how much history led to it. Subtracting the first
 * fully-known point makes the curve mean "PnL earned over the window", which is
 * what a period control above a chart promises.
 *
 * Each component is re-based against its own baseline, so the identity
 * `total = realized + unrealized` survives the shift.
 *
 * Uncovered days go through as all-null, for the same reason the net-worth
 * curve breaks over them: on a day nothing was priced the rollup's unrealized
 * PnL is `0 − costBasis`, a total loss the user never took.
 */
export function rebasePnlSeries(series: readonly PnLPoint[]): PnLChartPoint[] {
  const points = series.map((row) =>
    hasKnownCoverage(row)
      ? {
          date: row.date,
          total: toFiniteNumber(row.totalPnl),
          realized: toFiniteNumber(row.realizedPnl),
          unrealized: toFiniteNumber(row.unrealizedPnl),
        }
      : { date: row.date, total: null, realized: null, unrealized: null }
  );

  const base = points.find(
    (point) => point.total !== null && point.realized !== null && point.unrealized !== null
  );
  if (!base) return points;

  return points.map((point) => ({
    date: point.date,
    total: point.total === null ? null : point.total - (base.total ?? 0),
    realized: point.realized === null ? null : point.realized - (base.realized ?? 0),
    unrealized: point.unrealized === null ? null : point.unrealized - (base.unrealized ?? 0),
  }));
}

/**
 * The last point that actually has a PnL, which is what the hero figure reads.
 *
 * Not simply the last row: the rollup fills value before it fills PnL, so the
 * tail of a fresh series is routinely `null` and taking it would blank the
 * headline on a portfolio that has a perfectly good answer one day earlier.
 */
/**
 * The unrebased row behind the headline figure — what `<CoverageNote>` reads
 * while PnL is the metric on screen.
 *
 * `latestPnl` works on the rebased series, which has already dropped the
 * coverage counts to keep the chart's point shape minimal. The qualification
 * has to describe the *same* day the headline states, so it is picked by the
 * same rule rather than by taking the last row.
 */
export function latestPnlSource(series: readonly PnLPoint[]): PnLPoint | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const row = series[index];
    if (row && row.totalPnl !== null && hasKnownCoverage(row)) return row;
  }
  return null;
}

export function latestPnl(points: readonly PnLChartPoint[]): PnLChartPoint | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point && point.total !== null) return point;
  }
  return null;
}

/** The `assetAllocation` block of `dashboard.getOverview`, narrowed to what the bar reads. */
export interface AllocationItem {
  id: string;
  /** The dimension's *human* key — a type code, an institution's name. */
  code?: string;
  name: string;
  value: string;
}

/**
 * The dimensions the allocation block can be cut by — v2's four, unchanged.
 *
 * The API offers seven (`AssetAllocationDimensionDto`); the three left out are
 * `token`, `account_type` and `institution_type`. `token` is the holdings list
 * with extra steps, and the two `*_type` cuts split a portfolio into two or
 * three buckets that nobody groups by. Four options is also the width a
 * segmented control can carry on a 390px phone without truncating a label.
 */
/**
 * The four cuts, carrying i18n KEYS rather than English (SC-201).
 *
 * The same shape `V3_TAB_ITEMS` already uses, and for the same reason: a data
 * table in `lib/` has no `t` and must not acquire one — it is imported by
 * `holdingsConfig` and by tests as plain data. Resolving the key at the call
 * site keeps the table pure and keeps the string in `en.json`.
 */
export const ALLOCATION_DIMENSIONS = [
  { key: 'token_type', labelKey: 'v3.home.allocation.dimension.tokenType' },
  { key: 'institution', labelKey: 'v3.home.allocation.dimension.institution' },
  { key: 'account', labelKey: 'v3.home.allocation.dimension.account' },
  { key: 'group', labelKey: 'v3.home.allocation.dimension.group' },
] as const;

export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number]['key'];

export const DEFAULT_ALLOCATION_DIMENSION: AllocationDimension = 'token_type';

/** The cuts a persisted choice is checked against — see `useViewPreference`. */
export const ALLOCATION_DIMENSION_KEYS: readonly AllocationDimension[] = ALLOCATION_DIMENSIONS.map(
  (dimension) => dimension.key
);

/**
 * Which holdings-list filter each cut is spelled as.
 *
 * The four cuts are exactly the four dimensions `holdingsConfig` filters on,
 * which is not a coincidence: §2.1's IA change made institutions, accounts and
 * groups *dimensions of the holdings list*, and an allocation slice is the same
 * dimension read as a share instead of as a list.
 */
const ALLOCATION_FILTER_PARAM: Record<AllocationDimension, string> = {
  token_type: 'tokenType',
  institution: 'institution',
  account: 'account',
  group: 'group',
};

/**
 * `dashboard.getAssetAllocation` returns one synthetic row on the group cut:
 * everything belonging to no group at all. It is a real share of the money and
 * a real thing to see, and it is not a record — `?group=ungrouped` would filter
 * the holdings list to nothing.
 */
const UNGROUPED_KEY = 'ungrouped';

/**
 * Where an allocation row goes, or `null` for a row that stands for no record.
 *
 * Every cut lands on the **holdings list filtered to that slice** rather than
 * on the slice's own page, and the four behave alike deliberately: the reader
 * toggles between them with one control, so a row that opened a group page
 * under one cut and a filtered list under the next would make the control mean
 * two things. It is also the honest answer to what an allocation row asks —
 * "what is inside this share" — which is a list of holdings, not a record.
 *
 * A group's own row in `GroupsBlock` still opens the group's page. That block
 * lists group *records* (with their member counts); this one lists slices of
 * one figure.
 */
export function allocationHref(dimension: AllocationDimension, key: string): string | null {
  if (key === ALLOCATION_OTHER_KEY) return null;
  if (dimension === 'group' && key === UNGROUPED_KEY) return null;
  const param = ALLOCATION_FILTER_PARAM[dimension];
  return `${V3_ROUTES.holdings}?${param}=${encodeURIComponent(key)}`;
}

/**
 * Allocation items as allocation-bar input, biggest first.
 *
 * `foldAllocation` colours by position and folds the tail, so the caller's
 * order decides both. Value-descending is the order the API already returns
 * and the one the fold needs — folding by any other key would drop a large
 * category into "Other" while a small one kept a slot. The cost is that two
 * categories swapping rank swap their colours; with a handful of asset types
 * whose ranks are stable over months, that is the cheaper of the two errors.
 *
 * `key` is **the value the holdings list filters on**, not simply the API's
 * `id`, so `allocationHref` needs no second lookup. The two agree everywhere
 * except the type cut, where `AssetAllocationService` sets `id` to the token
 * type's uuid and `code` to its code — and `?tokenType=` matches
 * `token.typeCode` (`holdingsConfig`). Keyed by the uuid, every type row would
 * have opened an empty list.
 */
export function allocationItems(
  t: TFunction,
  items: readonly AllocationItem[],
  dimension: AllocationDimension
): AllocationInput[] {
  return items
    .flatMap((item) => {
      const value = toFiniteNumber(item.value);
      if (value === null || value <= 0) return [];
      const key = dimension === 'token_type' ? (item.code ?? item.id) : item.id;
      // Only the type cut is translatable: the other three name an institution,
      // an account or a group, and those are the reader's own words or a brand.
      const label =
        dimension === 'token_type' ? tokenTypeLabel(t, item.code, item.name) : item.name;
      return [{ key, label, value }];
    })
    .sort((a, b) => b.value - a.value);
}

/**
 * The parts the bar folded away, so the block can offer them behind a
 * disclosure instead of losing them.
 *
 * `foldAllocation` caps the bar at six segments because slots 7 and 8 are
 * `--interactive`'s and `--loss`'s hues — a colour constraint, not a density
 * one, so raising the cap is not available. Cut by account this user has twenty
 * parts, and nineteen of them disappearing into "Other" is exactly the loss of
 * information this screen is being fixed for. The remainder is therefore listed
 * in full and uncoloured: no slot is spent, so no constraint is broken.
 */
export function foldedAllocationItems(
  items: readonly AllocationInput[],
  shown: readonly { key: string }[]
): AllocationInput[] {
  const kept = new Set(shown.map((segment) => segment.key));
  return items.filter((item) => !kept.has(item.key));
}

/** The subset of `dashboard.getOverview`'s `topHoldings` rows this screen reads. */
export interface TopHoldingItem {
  id: string;
  symbol: string;
  name: string;
  /**
   * `dashboard.getOverview` calls it `tokenTypeCode`; it is the `token_types.code`
   * that `tokenDisplayName` needs to tell a fiat row from the rest. The wire has
   * always carried it (`DashboardService`) and this interface used to drop it,
   * which is the whole of SC-824: home rendered the stored English name while
   * every other surface rendered the reader's own (SC-419).
   */
  tokenTypeCode?: string | null;
  value: string;
  institutionName?: string;
  accountName?: string;
}

export interface TopHoldingRow {
  /** The row's React key — the API's id, which is unique per rank. */
  key: string;
  /** The real holding, for the peek URL. */
  holdingId: string;
  symbol: string;
  /** "Bitcoin · Kraken", already assembled: the row has one sublabel slot. */
  sublabel: string;
  value: number;
  /** Share of the portfolio, 0-100. `null` when the total is unknown or zero. */
  share: number | null;
}

/**
 * `dashboard.getOverview` returns top holdings keyed `<uuid>-<rank>`, so the id
 * that reaches the peek URL has to have its rank suffix stripped — the same
 * `replace` v2's list does, kept here where it can be tested rather than
 * inlined in JSX. Two holdings of the same token in different accounts are two
 * rows with two uuids, so the strip cannot collide.
 */
export function topHoldingRows(
  t: TFunction,
  items: readonly TopHoldingItem[],
  totalValue: number | string | null | undefined
): TopHoldingRow[] {
  const total = toFiniteNumber(totalValue);

  return items.flatMap((item) => {
    const value = toFiniteNumber(item.value);
    if (value === null) return [];
    const where = [item.institutionName, item.accountName].filter(Boolean).join(' · ');
    const name = tokenDisplayName(t, {
      symbol: item.symbol,
      name: item.name,
      typeCode: item.tokenTypeCode,
    });
    return [
      {
        key: item.id,
        holdingId: item.id.replace(/-\d+$/, ''),
        symbol: item.symbol,
        sublabel: where ? `${name} · ${where}` : name,
        value,
        share: total === null || total <= 0 ? null : (value / total) * 100,
      },
    ];
  });
}

/** The subset of `groups.getAllWithCounts`'s rows the groups block reads. */
export interface GroupItem {
  id: string;
  name: string;
  color: string | null;
  holdingsCount: number;
  accountsCount: number;
}

export interface GroupRow {
  id: string;
  name: string;
  /** The user's own colour for the group. `null` renders no swatch. */
  color: string | null;
  /** "6 holdings · 2 accounts". Never "0 holdings · 0 accounts" — see below. */
  sublabel: string;
  /** Base-currency value of everything in the group, or `null` if unpriced. */
  value: number | null;
}

/**
 * `1 holding`, `2 holdings`, nothing at zero — the groups block drops an empty
 * half of the line rather than printing "0 accounts" next to a real count.
 */
function countPhrase(count: number, nounKey: string, t: TFunction): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return t(nounKey, { count });
}

/**
 * Groups joined to their value.
 *
 * A group is a *bucket of money*, so a summary that could only say "6 holdings"
 * would be the counts card this block exists to replace, wearing a different
 * name. The value comes from `groups.getValues` — one aggregate, shared with
 * the groups list and the group's own page (SC-87). It used to come from the
 * allocation cut by group, joined here on the client, which meant this block
 * and the two group surfaces could not be made to agree without three
 * implementations agreeing; a group's value is now one number computed once.
 *
 * Ordered by value, biggest first, with the unpriceable last — the same ranking
 * the rest of the screen uses.
 */
export function groupRows(
  groups: readonly GroupItem[],
  values: readonly GroupValue[],
  t: TFunction
): GroupRow[] {
  const valueById = groupValuesById(values);

  return groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      sublabel:
        [
          countPhrase(group.holdingsCount, 'v3.membership.count.holding', t),
          countPhrase(group.accountsCount, 'v3.membership.count.account', t),
        ]
          .filter(Boolean)
          .join(' · ') || t('v3.home.groups.empty'),
      value: groupAmount(valueById.get(group.id)),
    }))
    .sort((a, b) => compareGroupAmounts(a.value, b.value, 'desc'));
}

/** The subset of `vaults.getAll`'s rows the vaults block reads. */
export interface VaultItem {
  id: string;
  name: string;
  color: string | null;
  currencySymbol: string;
  currentAmount: string;
  targetAmount: string;
  progress: number;
}

export interface VaultRow {
  id: string;
  name: string;
  color: string | null;
  currency: string;
  current: number;
  target: number;
  /** The real figure, which may exceed 100. */
  progress: number;
  /** What the track draws, clamped to 0-100. */
  fill: number;
}

/**
 * Vault progress, with the bar and the figure deliberately allowed to disagree.
 *
 * An over-funded vault is genuinely at 130%, and rounding that away in the
 * figure would hide the one fact worth acting on. The *track* still stops at
 * full, because a bar overflowing its own container is a rendering bug in every
 * other context and nobody reads it as good news.
 */
export function vaultRows(vaults: readonly VaultItem[]): VaultRow[] {
  return vaults.map((vault) => ({
    id: vault.id,
    name: vault.name,
    color: vault.color,
    currency: vault.currencySymbol,
    current: toFiniteNumber(vault.currentAmount) ?? 0,
    target: toFiniteNumber(vault.targetAmount) ?? 0,
    progress: Number.isFinite(vault.progress) ? vault.progress : 0,
    fill: Math.min(Math.max(Number.isFinite(vault.progress) ? vault.progress : 0, 0), 100),
  }));
}

/** The subset of `payments.upcoming`'s rows the home block reads. */
export interface UpcomingOccurrence {
  id: string;
  dueDate: string;
  expectedAmount: string | null;
  actualAmount: string | null;
  payment: {
    id: string;
    vendorId: string;
    currencyTokenId: string;
    direction: string;
  };
}

export function nextPayments<T extends UpcomingOccurrence>(
  occurrences: readonly T[],
  today: string,
  limit: number
): T[] {
  return occurrences
    .filter((occurrence) => occurrence.dueDate >= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, limit);
}

const DUE_UNITS: readonly { limit: number; divisor: number; key: string }[] = [
  { limit: 14, divisor: 1, key: 'v3.home.dueIn.days' },
  { limit: 60, divisor: 7, key: 'v3.home.dueIn.weeks' },
  { limit: Number.POSITIVE_INFINITY, divisor: 30, key: 'v3.home.dueIn.months' },
];

/**
 * "Today" / "Tomorrow" / "in 9 days" / "in 3 weeks".
 *
 * Both arguments are `YYYY-MM-DD` strings and the difference is taken in UTC,
 * which is what `payments.upcoming` compares against server-side — going
 * through a local `Date` would move a bill due at midnight by a day for anyone
 * east of Greenwich.
 */
export function formatDueIn(dueDate: string, today: string, t: TFunction): string {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const from = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(from)) return dueDate;

  const days = Math.round((due - from) / DAY_MS);
  if (days <= 0) return t('v3.home.dueIn.today');
  if (days === 1) return t('v3.home.dueIn.tomorrow');

  // The unit's whole phrase is the key — "in {{count}} weeks" rather than
  // "in " + count + " " + unit + plural-s (SC-201). The preposition, the
  // number's position and the unit's plural all vary together by language, so
  // they cannot be three separate pieces.
  const scale = DUE_UNITS.find((entry) => days < entry.limit) as (typeof DUE_UNITS)[number];
  return t(scale.key, { count: Math.round(days / scale.divisor) });
}
