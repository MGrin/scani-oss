import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PullToRefreshIndicator } from '../../../src/v3/components/PullToRefreshIndicator';
import type { PullPhase } from '../../../src/v3/hooks/usePullToRefresh';

function indicator(phase: PullPhase, distance: number): string {
  return renderToStaticMarkup(
    <PullToRefreshIndicator
      distance={distance}
      phase={phase}
      progress={Math.min(distance / 72, 1)}
    />
  );
}

describe('PullToRefreshIndicator — what each phase says', () => {
  test('idle is present but invisible, so the first frame of a pull has nothing to mount', () => {
    const html = indicator('idle', 0);
    expect(html).toInclude('opacity:0');
    // Parked a chip-height above the top edge, where the wrapper clips it.
    expect(html).toInclude('translateY(-44px)');
  });

  test('pulling follows the finger with no transform transition', () => {
    const html = indicator('pulling', 30);
    // The chip rides in the gap the page has opened, not on top of the page.
    expect(html).toInclude('translateY(-14px)');
    expect(html).toInclude('opacity:1');
    // Easing the transform while the finger is down renders the pull as lag.
    expect(html).toInclude('transition-opacity');
    expect(html).not.toInclude('transition-[transform,opacity]');
  });

  test('the armed state is a distinct fill, not a bigger arrow', () => {
    expect(indicator('pulling', 30)).not.toInclude('bg-interactive');
    expect(indicator('ready', 72)).toInclude('bg-interactive');
  });

  test('releasing eases back, so the chip does not snap away', () => {
    expect(indicator('idle', 0)).toInclude('transition-[transform,opacity]');
  });

  test('the chip stays inside the gap at full pull', () => {
    // 96 is the hook's MAX_DISTANCE: the chip must still be below the top
    // edge and above the page, not overlapping either.
    expect(indicator('ready', 96)).toInclude('translateY(52px)');
  });

  test('refreshing spins and drops the dial rotation', () => {
    const html = indicator('refreshing', 72);
    expect(html).toInclude('v3-pull-spin');
    expect(html).not.toInclude('rotate(');
  });

  test('the refresh is announced, because a rotating arrow is not', () => {
    expect(indicator('refreshing', 72)).toInclude('Refreshing');
    expect(indicator('pulling', 30)).not.toInclude('Refreshing');
  });

  test('uses the v3 tokens, not v2 chrome', () => {
    const html = indicator('pulling', 30);
    expect(html).toInclude('border-border-strong');
    expect(html).toInclude('bg-surface-1');
    expect(html).not.toInclude('bg-card');
  });
});

describe('the spinner is the only thing that animates on its own', () => {
  const css = readFileSync(resolve(import.meta.dir, '../../../src/styles/v3-motion.css'), 'utf8');

  test('and it is behind a reduced-motion guard', () => {
    const rule = css.slice(css.indexOf('.v3-pull-spin {'));
    const guard = css.lastIndexOf(
      '@media (prefers-reduced-motion: no-preference)',
      css.indexOf('.v3-pull-spin {')
    );
    expect(guard).toBeGreaterThan(-1);
    expect(rule).toInclude('animation: v3-pull-spin');
  });
});
