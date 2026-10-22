import type { Page } from '@playwright/test';

/** One box that moved after the page first showed content. */
export interface LateMove {
  /** Milliseconds since the document started. */
  at: number;
  label: string;
  /** Pixels, positive = pushed down. */
  by: number;
}

/**
 * Watches every top-level box in `main` from the first frame and reports each
 * one that moves once the page has shown content (SC-1742).
 *
 * WebKit has no Layout Instability API, so this samples positions once a
 * frame. A box is top-level when no other watched box contains it, so a card
 * that moves is reported once, not once per row inside it. Positions are page
 * coordinates, so the reader scrolling is never mistaken for a shift.
 *
 * Off-screen boxes count too: a reader scrolls while a page loads, and a
 * section that grows 700 px under the fold is the jump they meet.
 */
export async function watchLayout(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ids = new WeakMap<Element, number>();
    let next = 1;
    let prev = new Map<number, { top: number; label: string }>();
    let painted = false;
    const moves: { at: number; label: string; by: number }[] = [];
    const rowsSeen = new WeakSet<Element>();
    const rows: { at: number; label: string }[] = [];
    const selector = [
      'main a[href*="/home/"]',
      'main [class*="rounded-lg"][class*="border"]',
      'main .animate-pulse',
      'main h1:not(.sr-only)',
      'main h2',
    ].join(',');
    const tick = () => {
      const boxes = Array.from(document.querySelectorAll(selector));
      const watched = new Set(boxes);
      const cur = new Map<number, { top: number; label: string }>();
      for (const el of boxes) {
        let parent = el.parentElement;
        while (parent && !watched.has(parent)) parent = parent.parentElement;
        if (parent) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        let id = ids.get(el);
        if (id === undefined) {
          id = next++;
          ids.set(el, id);
        }
        const text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
        cur.set(id, { top: Math.round(rect.top + window.scrollY), label: text.slice(0, 40) });
        if (!el.classList.contains('animate-pulse') && text) painted = true;
      }
      if (painted) {
        for (const [id, box] of cur) {
          const before = prev.get(id);
          if (before && Math.abs(box.top - before.top) > 1)
            moves.push({
              at: Math.round(performance.now()),
              label: box.label,
              by: box.top - before.top,
            });
        }
      }
      // A row added to a list grows its card rather than moving it, so rows
      // are recorded on their own: the frame each `li` was first on screen.
      for (const row of Array.from(document.querySelectorAll('main li'))) {
        if (rowsSeen.has(row) || row.closest('[hidden], .animate-pulse')) continue;
        const rect = row.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        rowsSeen.add(row);
        rows.push({
          at: Math.round(performance.now()),
          label: ((row as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        });
      }
      prev = cur;
      const w = window as unknown as {
        __lateMoves: typeof moves;
        __rows: typeof rows;
        __painted: boolean;
      };
      w.__lateMoves = moves;
      w.__rows = rows;
      w.__painted = painted;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Whether the page showed content at all: the control that keeps an empty
 *  `lateMoves` from passing over a page that never left its skeleton. */
export async function paintedContent(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __painted?: boolean }).__painted === true);
}

/** Every list row, with the frame it was first on screen. */
export async function rowsShown(page: Page): Promise<{ at: number; label: string }[]> {
  return page.evaluate(
    () => (window as unknown as { __rows?: { at: number; label: string }[] }).__rows ?? []
  );
}

export async function lateMoves(page: Page): Promise<LateMove[]> {
  return page.evaluate(() => (window as unknown as { __lateMoves?: LateMove[] }).__lateMoves ?? []);
}

/**
 * Holds API calls back so queries arrive the way a phone sees them: every
 * request one round trip late, and the ones carrying `slow` procedures later
 * still. One HTTP batch answers only when its slowest member does, which is
 * the coupling this exists to expose.
 */
export async function delayApi(
  page: Page,
  apiBaseUrl: string,
  opts: {
    roundTripMs: number;
    slow: RegExp;
    slowMs: number;
    /** Answers to put in place of the server's, by procedure: for an account
     *  shape the test cannot reach through the API, such as agent access,
     *  which is a feature flag only an admin can turn on. */
    answers?: Record<string, unknown>;
  }
): Promise<void> {
  await page.route(`${apiBaseUrl}/trpc/**`, async (route) => {
    const procedures = (new URL(route.request().url()).pathname.split('/trpc/')[1] ?? '').split(
      ','
    );
    const extra = procedures.some((p) => opts.slow.test(p)) ? opts.slowMs : 0;
    await new Promise((resolve) => setTimeout(resolve, opts.roundTripMs + extra));
    const answers = opts.answers ?? {};
    if (!procedures.some((p) => p in answers)) {
      await route.continue().catch(() => {});
      return;
    }
    const response = await route.fetch().catch(() => null);
    if (!response) return;
    const body = (await response.json()) as unknown[];
    const patched = procedures.map((p, i) =>
      p in answers ? { result: { data: answers[p] } } : body[i]
    );
    await route.fulfill({ response, status: 200, json: patched }).catch(() => {});
  });
}
