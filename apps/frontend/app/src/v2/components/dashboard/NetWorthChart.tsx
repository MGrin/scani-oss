import { formatCompact, formatCurrency } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { trpc } from '@/lib/trpc';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { useUserJobs } from '../../hooks/useUserJobs';
import { V2_ROUTES } from '../../lib/routes';

type Granularity = 'daily' | 'weekly' | 'monthly';

// Range presets — each maps to a starting `windowDays`. Zoom + pan
// adjust this freely between renders; the buttons just snap to a
// preset and reset the right edge to "today".
const RANGE_OPTIONS: { label: string; days: number }[] = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '2Y', days: 730 },
];

const DEFAULT_DAYS = 90;
const MIN_DAYS = 7;
const MAX_DAYS = 1825; // 5 years
const DAY_MS = 24 * 60 * 60 * 1000;

// Debounce (ms) before propagating zoom/pan into the tRPC query —
// keeps continuous wheel/drag interaction from spamming the backend.
const QUERY_DEBOUNCE_MS = 200;

interface SeriesPoint {
  date: string;
  totalValue: string;
  coverageQuality: string;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
}

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatTick(iso: string, granularity: Granularity): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const month = MONTH_SHORT[m - 1] ?? '';
  if (granularity === 'monthly') return `${month} ${y}`;
  return `${month} ${d}`;
}

function clampDays(d: number): number {
  if (!Number.isFinite(d)) return DEFAULT_DAYS;
  if (d < MIN_DAYS) return MIN_DAYS;
  if (d > MAX_DAYS) return MAX_DAYS;
  return d;
}

function clampEndDate(d: Date): Date {
  const now = Date.now();
  return d.getTime() > now ? new Date(now) : d;
}

export function NetWorthChart() {
  const { symbol: baseSymbol, isLoading: baseLoading } = useBaseCurrency();
  // Surface backfill / tx-import progress to the chart. While any
  // chart-affecting job is running, the curve we render is stale —
  // signal that with the inline spinner; on a recent failure, show a
  // warning banner so the user knows the curve is incomplete.
  const { chartAffectingActive, chartAffectingFailure } = useUserJobs();

  // Continuous-zoom state. `windowDays` is the visible span; `endDate`
  // is the right edge of the chart. `from = endDate - windowDays`.
  // We keep these as plain state so wheel/drag handlers update them
  // synchronously without re-allocating Date objects in the render path.
  const [windowDays, setWindowDays] = useState(DEFAULT_DAYS);
  const [endDate, setEndDate] = useState<Date>(() => new Date());

  // Debounce the tRPC inputs so continuous zoom/pan doesn't spam the
  // backend. The chart itself updates instantly (React state), only the
  // query parameters lag by QUERY_DEBOUNCE_MS. Combined with
  // `keepPreviousData: true` on the query this produces a smooth zoom
  // without flicker.
  const [debouncedWindowDays, setDebouncedWindowDays] = useState(windowDays);
  const [debouncedEndDate, setDebouncedEndDate] = useState(endDate);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedWindowDays(windowDays);
      setDebouncedEndDate(endDate);
    }, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [windowDays, endDate]);

  const { from, to } = useMemo(
    () => ({
      from: new Date(debouncedEndDate.getTime() - debouncedWindowDays * DAY_MS),
      to: debouncedEndDate,
    }),
    [debouncedEndDate, debouncedWindowDays]
  );

  const { data, isLoading, isFetching } = trpc.portfolio.getNetWorthSeries.useQuery(
    { from, to, granularity: 'auto' },
    {
      enabled: !baseLoading,
      // Avoid flicker between fetches during zoom/pan.
      keepPreviousData: true,
    }
  );

  const granularity = (data?.granularity as Granularity | undefined) ?? 'daily';

  const chartData = useMemo(() => {
    const rows = (data?.series ?? []) as SeriesPoint[];
    return rows.map((r, i) => {
      const prev = i > 0 ? rows[i - 1] : undefined;
      const next = i + 1 < rows.length ? rows[i + 1] : undefined;
      const isFull = r.coverageQuality === 'full';
      const value = Number(r.totalValue);
      const nextIsDifferent = next && (next.coverageQuality === 'full') !== isFull;
      const prevIsDifferent = prev && (prev.coverageQuality === 'full') !== isFull;
      const emitBoth = nextIsDifferent || prevIsDifferent;
      return {
        date: r.date,
        valueFull: isFull || emitBoth ? value : null,
        valueEstimated: !isFull || emitBoth ? value : null,
        coverageQuality: r.coverageQuality,
        holdingsTotal: r.holdingsTotal,
        holdingsKnown: r.holdingsWithKnownValue,
      };
    });
  }, [data]);

  const isEmpty = !isLoading && chartData.length === 0;

  // Wheel + drag handlers wired imperatively because React's synthetic
  // wheel event is passive by default — preventDefault() does nothing,
  // and the page scrolls instead of the chart zooming. addEventListener
  // with `{ passive: false }` gives us preventable wheel events.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startEnd: number } | null>(null);

  // Snap to a range preset. Resets the right edge to "now".
  const handlePreset = useCallback((days: number) => {
    setWindowDays(days);
    setEndDate(new Date());
  }, []);

  // Pan by `daysShift` (positive = forward in time). End-date clamps
  // at "now"; we don't allow scrolling into the future.
  const panBy = useCallback((daysShift: number) => {
    setEndDate((prev) => clampEndDate(new Date(prev.getTime() + daysShift * DAY_MS)));
  }, []);

  // Zoom by `factor` (>1 = zoom out, <1 = zoom in). Keeps the right
  // edge fixed — center-cursor zoom is nicer but adds cursor-position
  // math; right-edge zoom matches "I'm looking at recent values, show
  // me more/less context" intuitively.
  const zoomBy = useCallback((factor: number) => {
    setWindowDays((prev) => clampDays(prev * factor));
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    // Wheel: deltaY = zoom (in/out), deltaX = pan. We choose the
    // dominant axis so trackpads with two-finger horizontal scroll pan
    // naturally and a vertical mouse-wheel zooms.
    const onWheel = (e: WheelEvent) => {
      // Ignore tiny noise from inertia residue.
      if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return;
      e.preventDefault();
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        // Zoom factor: 1.1× per ~100px wheel delta. Smooth on both
        // notched mouse wheels (deltaY ≈ 100 per click) and trackpads
        // (deltaY ≈ 1–10 per pixel).
        const factor = 1 + e.deltaY / 600;
        zoomBy(factor);
      } else {
        // Each ~100px of horizontal scroll moves the window by ~5% of
        // its current span. Feels right at every zoom level.
        const span = Math.max(windowDays, MIN_DAYS);
        const shift = (e.deltaX / 600) * span;
        panBy(shift);
      }
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [windowDays, panBy, zoomBy]);

  // Mouse drag-to-pan. Touch handlers below cover mobile.
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Ignore right-clicks / modifier-clicks; let those bubble.
      if (e.button !== 0) return;
      dragRef.current = { startX: e.clientX, startEnd: endDate.getTime() };
    },
    [endDate]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const node = containerRef.current;
      if (!node) return;
      const dx = e.clientX - drag.startX;
      const width = node.clientWidth || 1;
      // dx > 0 means dragging right → user wants OLDER content visible
      // → shift endDate BACKWARD (earlier).
      const daysShift = -(dx / width) * windowDays;
      setEndDate(clampEndDate(new Date(drag.startEnd + daysShift * DAY_MS)));
    };
    const onMouseUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [windowDays]);

  // Touch pan (single-finger swipe). Two-finger pinch zoom would be
  // nice but is significant extra code; for v1 the buttons + wheel
  // cover zoom and only pan needs touch support.
  const touchRef = useRef<{ startX: number; startEnd: number } | null>(null);
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return;
      touchRef.current = { startX: t.clientX, startEnd: endDate.getTime() };
    },
    [endDate]
  );
  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      const drag = touchRef.current;
      if (!t || !drag) return;
      const node = containerRef.current;
      if (!node) return;
      const dx = t.clientX - drag.startX;
      const width = node.clientWidth || 1;
      const daysShift = -(dx / width) * windowDays;
      setEndDate(clampEndDate(new Date(drag.startEnd + daysShift * DAY_MS)));
    },
    [windowDays]
  );
  const onTouchEnd = useCallback(() => {
    touchRef.current = null;
  }, []);

  const isAtToday = endDate.getTime() >= Date.now() - DAY_MS;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle className="text-sm font-medium">Net worth over time</CardTitle>
          {(isFetching && !isLoading) || chartAffectingActive ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
          ) : null}
          {chartAffectingActive && (
            <span className="text-[10px] text-muted-foreground">updating…</span>
          )}
        </div>
        <div className="flex gap-1 flex-wrap">
          {RANGE_OPTIONS.map((opt) => {
            const isActive = windowDays === opt.days && isAtToday;
            return (
              <button
                type="button"
                key={opt.label}
                onClick={() => handlePreset(opt.days)}
                className={`px-2 py-1 text-xs rounded ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
          {!isAtToday && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => setEndDate(new Date())}
            >
              Today →
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading || baseLoading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : isEmpty ? (
          <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
            No portfolio value in this range. Drag or zoom out, or wait for the history backfill to
            finish.
          </div>
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: chart container — pointer/touch handlers wire zoom + pan; the interactive content is the inner Recharts SVG, not the wrapper.
          <div
            ref={containerRef}
            className="h-[220px] w-full select-none cursor-grab active:cursor-grabbing"
            onMouseDown={onMouseDown}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: string) => formatTick(v, granularity)}
                  minTickGap={32}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatCompact(v, baseSymbol)}
                  width={72}
                />
                <Tooltip
                  formatter={(v) =>
                    [formatCurrency(String(v ?? 0), baseSymbol), 'Value'] as [string, string]
                  }
                  labelFormatter={(label) => String(label ?? '')}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="valueFull"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="valueEstimated"
                  stroke="#94a3b8"
                  strokeDasharray="4 4"
                  fill="#94a3b8"
                  fillOpacity={0.1}
                  strokeWidth={2}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        {chartAffectingFailure && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              <div className="font-medium">Chart may be incomplete</div>
              <div className="text-muted-foreground">
                A recent {chartAffectingFailure.jobName.replace(/-/g, ' ')} job failed; the curve
                below excludes data that job would have produced.
                <Link
                  to={V2_ROUTES.jobDetail(chartAffectingFailure.jobId)}
                  className="ml-1 underline hover:text-foreground"
                >
                  Open job
                </Link>
              </div>
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          Solid line = full coverage · dashed line = partial/estimated. Drag to pan, scroll to zoom
          (vertical) or pan (horizontal).
        </p>
      </CardContent>
    </Card>
  );
}
