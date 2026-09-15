import '../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import i18n from 'i18next';

/**
 * SC-1206 — the home screen names itself in the heading tree.
 *
 * It did not, once it had data. Measured on `demo.scani.xyz` 2026-09-15, and
 * the control is the half that makes the zero a reading:
 *
 *     /            h1 count 0 · first headings H2:Allocation, H2:Upcoming bills
 *     /holdings    h1 count 1 · h1 "Holdings"
 *
 * Same build, same selector, minutes apart. A screen reader's heading
 * navigation starts at the top level, so on the dashboard the first jump
 * landed mid-content with nothing above it saying where the reader was.
 *
 * **A text scan rather than a render, and not for convenience.** `HomePage`
 * reaches four different returns off `dashboard.getOverview`'s state, and
 * rendering it needs a tRPC provider, a router and a query client — a harness
 * that would itself decide which branch is under test. The question here is
 * "does every branch name the page", which is a question about the file.
 *
 * `detail-route-headings.test.tsx` is the sibling that owns the peek routes.
 */

const V3 = join(import.meta.dir, '..', '..', 'src', 'v3');
const PAGES = join(V3, 'pages');

async function pageSource(file: string): Promise<string> {
  return Bun.file(join(PAGES, file)).text();
}

/**
 * The ways a v3 page legitimately reaches a top-level heading. Four of them
 * are shared headers that render the `h1` themselves, which is why a scan for
 * `<h1` alone reports pages that are perfectly correct.
 */
const REACHES_A_HEADING =
  /<h1|PageHeader|CaptureHeader|HomeHeading|PeekHeader|JobDetailHeader|DocumentDetailHeader/;

/**
 * Enumerated rather than pattern-matched, because an exception needs a reason
 * and a regex cannot carry one.
 *
 * `KitchenSinkPage` is the visual-baseline playground — every v3 primitive on
 * one screen, rendered by `bun run visual` and by nobody else. Giving it a
 * heading is a one-line change and a four-baseline churn, and it is not this
 * ticket: the defect SC-1206 describes is a screen real readers land on.
 */
const NO_HEADING_YET = new Set(['KitchenSinkPage.tsx']);

describe('every v3 page names itself at the top level', () => {
  test('no routed page is left without a heading', async () => {
    const files = readdirSync(PAGES).filter((name) => name.endsWith('.tsx'));
    // Control: the sweep found the pages. A zero-length list passes every
    // assertion below it and says nothing.
    expect(files.length).toBeGreaterThan(20);

    const missing: string[] = [];
    for (const file of files) {
      if (NO_HEADING_YET.has(file)) continue;
      if (!REACHES_A_HEADING.test(await pageSource(file))) missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  test('the exception list is live, not a stale note', async () => {
    // If somebody gives the kitchen sink a heading, this reddens and the entry
    // above comes out — rather than sitting there forever describing a file
    // that has since been fixed.
    for (const file of NO_HEADING_YET) {
      expect(REACHES_A_HEADING.test(await pageSource(file))).toBe(false);
    }
  });
});

describe('the home screen, in every state it renders', () => {
  /**
   * `HomePage` returns from four places: the overview failed, the overview has
   * not answered, the account is empty, and the dashboard proper. The demo and
   * every real user are on the last one, which is exactly the branch that had
   * no heading — a fresh account reads 1 through `FirstRunPanel`'s own `h1`,
   * so the bug was invisible to anyone looking at a new account.
   */
  test('each of its four branches names the page', async () => {
    const source = await pageSource('HomePage.tsx');
    // From the component only: `HomeSkeleton` above it also returns JSX, and
    // counting that as a branch would make this pass for the wrong reason.
    const body = source.slice(source.indexOf('export function HomePage()'));
    // Three of the four are inside an `if`, so the indent varies; the anchor
    // is "a return of JSX", not a column.
    const branches = body.split(/\n {2,4}return \(/).slice(1);

    expect(branches).toHaveLength(4);
    for (const [index, branch] of branches.entries()) {
      const named = branch.includes('<HomeHeading />') || branch.includes('<FirstRun ');
      expect(named, `HomePage branch ${index + 1} renders no top-level heading`).toBe(true);
    }
  });

  test('the heading is an h1 carrying the name the tab and the title use', async () => {
    const source = await pageSource('HomePage.tsx');
    expect(source).toContain(`<h1 className="sr-only">{t('nav.home')}</h1>`);
    // The same key the document title takes, which is what stops one screen
    // acquiring three names.
    expect(source).toContain(`useDocumentTitle(t('nav.home'))`);
    // Control: the key resolves. i18next renders a missing key AS the key, so
    // without this the assertion above would pass over `nav.home` on screen.
    expect(i18n.t('nav.home')).toBe('Home');
  });

  /**
   * `sr-only` is `position: absolute`, so the element has no size — but a flex
   * or grid `gap` is charged between CHILDREN, not between rendered boxes. As
   * the first child of `PageLayout` (`gap-4`) or `DashboardGrid` (`gap-6`, and
   * `lg:gap-4`) it would push every block below it down by a gap, on the one
   * screen with a committed fold assertion. Outside both, it costs nothing.
   */
  test('it is layout-neutral, so no home baseline moves', async () => {
    const source = await pageSource('HomePage.tsx');
    // Every mount is the first child of a fragment — never of a container that
    // charges a gap. Stated as what must precede it rather than as a list of
    // containers it must avoid: the second form goes stale the day someone
    // adds a third layout primitive.
    const mounts = source.split('<HomeHeading />');
    // Control: it IS mounted, so the claim below is about placement rather
    // than about a component nothing renders.
    expect(mounts).toHaveLength(4);
    for (const before of mounts.slice(0, -1)) {
      expect(before.trimEnd().endsWith('<>'), 'HomeHeading is not a fragment’s first child').toBe(
        true
      );
    }
  });
});
