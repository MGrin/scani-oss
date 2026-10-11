import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRelativeTimeTick } from '../../../src/v3/lib/relative-time-tick';

/**
 * Relative times never ticked: "5m ago" stayed "5m ago" until something else
 * re-rendered it (SC-1599, from the SC-1598 liveness audit).
 */

function fakeScheduler() {
  const live = new Map<number, () => void>();
  let next = 0;
  return {
    live,
    set: (tick: () => void) => {
      next += 1;
      live.set(next, tick);
      return next;
    },
    clear: (handle: unknown) => {
      live.delete(handle as number);
    },
    fire: () => {
      for (const tick of live.values()) tick();
    },
  };
}

describe('the shared relative-time tick', () => {
  test('every subscriber is notified on a tick, from one interval', () => {
    const scheduler = fakeScheduler();
    const tick = createRelativeTimeTick(scheduler);
    const seen: string[] = [];
    tick.subscribe(() => seen.push('a'));
    tick.subscribe(() => seen.push('b'));
    expect(scheduler.live.size).toBe(1);
    scheduler.fire();
    expect(seen).toEqual(['a', 'b']);
  });

  test('the interval stops when the last subscriber leaves, and restarts on the next', () => {
    const scheduler = fakeScheduler();
    const tick = createRelativeTimeTick(scheduler);
    const leaveA = tick.subscribe(() => {});
    const leaveB = tick.subscribe(() => {});
    leaveA();
    expect(scheduler.live.size).toBe(1);
    leaveB();
    expect(scheduler.live.size).toBe(0);
    tick.subscribe(() => {});
    expect(scheduler.live.size).toBe(1);
  });
});

/**
 * A spec builder renders inside another component, so the tick belongs to the
 * component that renders it. Each target must call the hook itself.
 */
const RENDERED_BY: Record<string, string> = {
  'v3/components/holdings/holdingsConfig.tsx': 'v3/pages/HoldingsPage.tsx',
  'v3/components/holdings/holdingPeek.tsx': 'v3/pages/HoldingsPage.tsx',
};

const SRC = join(import.meta.dir, '../../../src');
const RELATIVE_CALL = /\b(formatRelative|occurredLabel)\(/;
const TICK_CALL = /\buseRelativeTimeTick\(\)/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') ? [relative(SRC, path)] : [];
  });
}

describe('every component that renders a relative time ticks', () => {
  const rendering = tsxFiles(join(SRC, 'v3')).filter((file) =>
    RELATIVE_CALL.test(readFileSync(join(SRC, file), 'utf8'))
  );

  test('control: the scan finds the components that render relative times', () => {
    expect(rendering.length).toBeGreaterThanOrEqual(12);
    expect(rendering).toContain('v3/components/entities/AccountsList.tsx');
  });

  test('each one calls useRelativeTimeTick, or is rendered by a component that does', () => {
    const missing = rendering.filter((file) => {
      const ticker = RENDERED_BY[file] ?? file;
      return !TICK_CALL.test(readFileSync(join(SRC, ticker), 'utf8'));
    });
    expect(missing).toEqual([]);
  });
});
