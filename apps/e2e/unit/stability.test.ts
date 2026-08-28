import { describe, expect, test } from 'bun:test';
import type { Page } from '@playwright/test';
import {
  assertPixelsSettled,
  STABILITY_ATTEMPTS,
  STABILITY_GAP_MS,
  STABILITY_TIMEOUT_MS,
} from '../visual/stability';

/**
 * That the SC-832 guard can actually fire.
 *
 * ## Why this sits in `unit/` and not in `tests/`
 *
 * `apps/e2e/tests/` holds 33 PLAYWRIGHT specs, and bun's default patterns
 * match `*.spec.ts` as well as `*.test.ts`. Adding `apps/e2e/tests/` to the
 * root `test` script therefore sweeps every one of them into `bun test`, where
 * they die with `Playwright Test did not expect test.describe() to be called
 * here` — measured, 31 failures across 32 files. So this directory exists to
 * be a place the root script can point at safely, and it must stay free of
 * `.spec.ts`. That failure is LOUD rather than silent, which is why it is
 * documented here rather than guarded by another test.
 *
 * The defect it exists for is a check that reports success over a page it
 * never verified, so a test asserting only the happy path would reproduce the
 * bug in the guard's own coverage: a probe that returns without throwing on
 * every input passes a settled-page test perfectly.
 *
 * Both arms therefore run against the SAME function with the SAME shape of
 * fake, differing only in whether the page holds still.
 */

/**
 * A Page whose Nth screenshot is `frame(n)`.
 *
 * A function rather than a fixed list, because the probe's cap is now derived
 * from the timeout (21 attempts) and a hand-written array would silently stop
 * driving the loop the moment either constant changed -- the fake would repeat
 * its last frame, the probe would see two identical captures, and the
 * never-settles arm would go GREEN while asserting it had gone red.
 */
function fakePage(frame: (n: number) => string): { page: Page; shots: () => number } {
  let i = 0;
  const page = {
    screenshot: async () => {
      i += 1;
      return Buffer.from(frame(i));
    },
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  return { page, shots: () => i };
}

describe('assertPixelsSettled', () => {
  test('a page that holds still passes, and stops early', async () => {
    const { page, shots } = fakePage(() => 'same');
    await assertPixelsSettled(page, 'still');
    // Two captures is enough: the criterion is two CONSECUTIVE identical, the
    // same one `toHaveScreenshot` uses. A guard that always took all five
    // would pass this assertion too, so the count is asserted, not the verdict.
    expect(shots()).toBe(2);
  });

  test('a page that never settles THROWS — the arm the defect needs', async () => {
    const { page, shots } = fakePage((n) => `frame-${n}`);
    let thrown: Error | undefined;
    try {
      await assertPixelsSettled(page, 'moving');
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(shots()).toBe(STABILITY_ATTEMPTS);
    // The message has to name the screen and say nothing was written, because
    // `failWith`'s "already overwritten, git checkout it" warning is UNTRUE
    // here -- this fires before the capture.
    expect(thrown?.message).toContain('moving');
    expect(thrown?.message).toContain('still moving');
    expect(thrown?.message).toContain('Nothing has been written');
  });

  test('settling late still passes — it is two CONSECUTIVE, not all-identical', async () => {
    // The first pair differs, the second matches. A guard written as "every
    // capture identical" would fail this, and would then red on any page that
    // finishes laying out during the probe.
    const { page, shots } = fakePage((n) => (n === 1 ? 'a' : 'b'));
    await assertPixelsSettled(page, 'late');
    expect(shots()).toBe(3);
  });

  test('a screen that settles LATE is still photographed, not refused', async () => {
    // The arm that catches the false-red version of this guard. The first
    // draft ran a 1000ms budget against toHaveScreenshot's 5000ms, so a chart
    // finishing at 2s would have been REFUSED here and captured perfectly well
    // by the matcher — the gate going red on screens it can photograph, which
    // is how a guard gets deleted. Settling at capture 9 of a 21-capture
    // budget must pass.
    const settlesAt = 9;
    const { page, shots } = fakePage((n) => (n < settlesAt ? `frame-${n}` : 'settled'));
    await assertPixelsSettled(page, 'slow-chart');
    expect(shots()).toBe(settlesAt + 1);
    expect(settlesAt + 1).toBeLessThan(STABILITY_ATTEMPTS);
  });

  test('the budget is a real one, not a placeholder', () => {
    expect(STABILITY_ATTEMPTS).toBeGreaterThan(1);
    expect(STABILITY_GAP_MS).toBeGreaterThan(0);
    // MATCHED to toHaveScreenshot's own 5000ms, not shorter. A shorter budget
    // refuses screens the matcher would have captured; a longer one waits past
    // the point the matcher has already given up.
    expect(STABILITY_TIMEOUT_MS).toBe(5000);
    expect(STABILITY_ATTEMPTS * STABILITY_GAP_MS).toBeGreaterThanOrEqual(STABILITY_TIMEOUT_MS);
  });
});
