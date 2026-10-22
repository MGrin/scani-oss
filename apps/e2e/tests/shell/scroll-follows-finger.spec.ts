import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';

/**
 * SC-1714. On a phone the header and the tab bar slide away while the page is
 * read (SC-1631). They did it by collapsing the header's height above the
 * scroller, so the page moved 56px further than the finger going down and
 * snapped back going up: "page jumps, and scrolling feels too fast". Content
 * must move exactly as far as the scroller does, in both directions.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('content moves 1:1 with the scroll, down and back up, while the bars slide', async ({
  page,
}, testInfo) => {
  await signIn({ page, testInfo });
  await page.goto('/');
  await page.locator('main').waitFor();

  const frames = await page.evaluate(async () => {
    const main = document.querySelector('main') as HTMLElement;
    // A tall page whatever this new user has, so there is room to scroll.
    const filler = document.createElement('div');
    filler.style.height = '3000px';
    main.prepend(filler);
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    await frame();
    const rows: { scrollTop: number; fillerTop: number }[] = [];
    const sample = () =>
      rows.push({ scrollTop: main.scrollTop, fillerTop: filler.getBoundingClientRect().top });
    sample();
    // A finger: down 8px a frame, a pause long enough for any slide to finish,
    // then back up, then a pause again.
    for (const [step, count] of [
      [8, 40],
      [0, 20],
      [-8, 20],
      [0, 20],
    ] as const) {
      for (let i = 0; i < count; i++) {
        main.scrollTop += step;
        await frame();
        sample();
      }
    }
    return rows;
  });

  // Where the content sits on screen, less how far the scroller moved: zero
  // throughout means nothing but the finger ever moved it.
  const [first] = frames;
  if (!first) throw new Error('no frame was sampled');
  const origin = first.fillerTop + first.scrollTop;
  const offFinger = frames.map((row) => Math.round(row.fillerTop + row.scrollTop - origin));
  expect(frames.at(-1)?.scrollTop).toBeGreaterThan(100);
  expect(Math.max(...offFinger.map(Math.abs)), `px off the finger by frame: ${offFinger}`).toBe(0);
});
