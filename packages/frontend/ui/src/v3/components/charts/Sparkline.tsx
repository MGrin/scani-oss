import { useMemo } from 'react';
import { Line, LineChart, YAxis } from 'recharts';
import { ChartFrame } from './ChartFrame';

/**
 * Trend shape, no axes, no gridlines, no tooltip — §2.1 of the research brief:
 * the phone home screen answers "what changed" with a shape, and tapping it
 * opens the real chart. A sparkline that grows a y-axis has become a small bad
 * chart instead of a good glyph.
 *
 * The line wears `--gain` / `--loss` rather than a categorical slot, because a
 * net-worth trend *means* good or bad. The data-viz rule is that a series
 * meaning good/bad takes status colour and a series that is merely "series 4"
 * takes categorical; mixing the two in one chart is what makes a dashboard
 * read as decorated rather than encoded. Direction is never colour alone —
 * the figure beside it carries a sign and an arrow (`<Numeric>`, V3-07), and
 * the shape itself is the second channel.
 */

export type SparklineTone = 'auto' | 'gain' | 'loss' | 'neutral';

const TONE_COLOR: Record<Exclude<SparklineTone, 'auto'>, string> = {
  gain: 'hsl(var(--gain))',
  loss: 'hsl(var(--loss))',
  neutral: 'hsl(var(--neutral))',
};

interface SparklineProps {
  /** In chronological order. Fewer than two points renders nothing. */
  data: readonly number[];
  /** Accessible name for the whole glyph — see `ChartFrame`. */
  label: string;
  tone?: SparklineTone;
  height?: number;
  className?: string;
}

/** First-to-last, not the sign of the last change: the glyph shows the period. */
export function resolveSparklineTone(data: readonly number[]): Exclude<SparklineTone, 'auto'> {
  const first = data[0];
  const last = data[data.length - 1];
  if (first === undefined || last === undefined || last === first) return 'neutral';
  return last > first ? 'gain' : 'loss';
}

export function Sparkline({ data, label, tone = 'auto', height = 40, className }: SparklineProps) {
  const points = useMemo(() => data.map((v, i) => ({ i, v })), [data]);

  // One point has no shape and zero points have nothing to draw. Rendering an
  // empty box keeps the tile's layout from jumping when history arrives.
  if (points.length < 2) return <div className={className} style={{ height }} />;

  const color = TONE_COLOR[tone === 'auto' ? resolveSparklineTone(data) : tone];
  const lastIndex = points.length - 1;

  return (
    <ChartFrame label={label} height={height} className={className}>
      {/* The margin is the stroke's half-width plus the end dot's radius and
          ring, so neither is clipped at the edge of the box. */}
      <LineChart data={points} margin={{ top: 6, right: 6, bottom: 6, left: 6 }}>
        {/* Without an explicit domain recharts anchors the axis at zero, which
            flattens any series that does not start near it — a net worth
            moving 100k → 102k would draw as a horizontal line. */}
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Line
          dataKey="v"
          type="linear"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          // A sparkline is read at a glance, in a tile, often several at once;
          // animating the draw makes a list of them flicker on every refetch.
          isAnimationActive={false}
          activeDot={false}
          dot={(props) => {
            const { cx, cy, index } = props as { cx: number; cy: number; index: number };
            return (
              <circle
                // Radius 0 rather than `null` for the other points: recharts
                // treats a null return from this renderer as a render error.
                key={`sparkline-dot-${index}`}
                cx={cx}
                cy={cy}
                r={index === lastIndex ? 4 : 0}
                fill={color}
                // The surface ring, so "now" stays legible where the line
                // doubles back over itself. `--card` is the tile it sits in.
                stroke="hsl(var(--card))"
                strokeWidth={2}
              />
            );
          }}
        />
      </LineChart>
    </ChartFrame>
  );
}
