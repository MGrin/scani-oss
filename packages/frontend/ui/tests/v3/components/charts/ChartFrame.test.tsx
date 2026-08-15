import { describe, expect, test } from 'bun:test';
import { ChartFrame } from '@scani/ui/v3/components/charts/ChartFrame';
import { Sparkline } from '@scani/ui/v3/components/charts/Sparkline';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Line, LineChart } from 'recharts';

/**
 * The frame's *rendered* output is verified by screenshot at `/v3/kitchen-sink`
 * — recharts sizes itself from a ResizeObserver, which server rendering has
 * none of. What is testable here is the thing that had no measurement to wait
 * for: recharts warns during the render body itself, so the first pass logs
 * whatever the container has resolved by then.
 *
 * Handed `height="100%"`, that was the container's `initialDimension` of -1,
 * and every chart in both SPAs logged `width(-1) and height(-1)` on every mount
 * (SC-126). recharts' `warn` is gated on a hardcoded `isDev = true`, so those
 * lines shipped to production consoles too, not just to `bun dev`.
 */

const CHART = (
  <LineChart
    data={[
      { i: 0, v: 1 },
      { i: 1, v: 2 },
    ]}
  >
    <Line dataKey="v" />
  </LineChart>
);

function warningsWhileRendering(node: ReactElement): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    renderToStaticMarkup(node);
  } finally {
    console.warn = original;
  }
  return warnings;
}

const isSizeWarning = (line: string) => /width\(.*\) and height\(.*\) of chart/.test(line);

describe('ChartFrame', () => {
  test('the height it was handed reaches recharts, so nothing renders at -1', () => {
    const warnings = warningsWhileRendering(
      <ChartFrame label="Net worth over the last 30 days, rising" height={200}>
        {CHART}
      </ChartFrame>
    );
    expect(warnings.filter(isSizeWarning)).toEqual([]);
  });

  test('everything built on the frame inherits that — a Sparkline warns too or not at all', () => {
    const warnings = warningsWhileRendering(
      <Sparkline data={[100, 130, 120, 140]} label="Net worth trend, rising" />
    );
    expect(warnings.filter(isSizeWarning)).toEqual([]);
  });
});
