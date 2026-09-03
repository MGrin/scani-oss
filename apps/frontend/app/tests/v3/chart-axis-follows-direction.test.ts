import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * That a v3 chart's value axis follows the document direction (SC-969).
 *
 * A static check, because there is nothing else. `bun test` renders through
 * `react-dom/server`, where recharts has no measured container and emits an
 * empty box whatever the props say, so no component test can see where an axis
 * landed. The rendered evidence is `home-phone-rtl.png` — and the RTL baseline
 * set is deliberately three screens, so `PortfolioChart` is photographed and
 * every other chart in the product is not.
 *
 * What it pins is the ONE decision that has a wrong answer available: a `YAxis`
 * that draws is placed by an x coordinate recharts computes, and left alone it
 * is pinned to the physical left in both directions. A `YAxis hide` has no
 * placement to get wrong — `Sparkline` uses one only to set a domain — so it is
 * exempt by the same reasoning rather than by an allowlist.
 *
 * Scoped to the v3 roots on purpose. `apps/frontend/cloud` renders a chart with
 * a visible axis too, and nothing in that app writes `<html dir>` — no
 * `applyFormatLocale`, no locale with `dir: 'rtl'` — so it cannot reach the
 * defect. Widening this to a surface with no direction would be asserting
 * something nobody can make false.
 */

const ROOTS = [
  resolve(import.meta.dir, '../../src/v3'),
  resolve(import.meta.dir, '../../../../../packages/frontend/ui/src/v3'),
];

const REPO = resolve(import.meta.dir, '../../../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The opening tag of every `<YAxis …>` in a file, tag contents included. */
function yAxisTags(source: string): string[] {
  return [...source.matchAll(/<YAxis\b[^>]*>/g)].map((match) => match[0]);
}

describe('v3 charts place their value axis from the document direction', () => {
  test('every YAxis that draws passes an orientation, and something says which', async () => {
    const offenders: string[] = [];
    let drawn = 0;

    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const source = await Bun.file(file).text();
        for (const tag of yAxisTags(source)) {
          if (/\bhide\b/.test(tag)) continue;
          drawn += 1;
          if (!/\borientation=/.test(tag)) offenders.push(relative(REPO, file));
        }
      }
    }

    // The control. A pass with nothing scanned is the same reading as a pass
    // with everything correct, and this file would keep reporting green after a
    // rename moved the roots out from under it.
    expect(drawn).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('the frame anchors chart text physically, whatever the document says', async () => {
    // SVG `text-anchor` is direction-relative while every recharts coordinate is
    // physical, so without this the tick label draws on the far side of an
    // anchor that did not move — measured at `bac193fd3` as the `$193.2K` tick
    // jumping from x=37..88 to x=89..140, over the gridline it labels.
    const frame = await Bun.file(
      join(REPO, 'packages/frontend/ui/src/v3/components/charts/ChartFrame.tsx')
    ).text();
    // On its own line, so this matches the JSX prop and not the comment above
    // it that quotes the same string. `toInclude('dir="ltr"')` passed with the
    // attribute deleted, which is a control that could never come back red.
    expect(frame).toMatch(/^\s*dir="ltr"\s*$/m);
  });
});
