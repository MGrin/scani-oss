/**
 * The screens the visual-regression gate holds a baseline for (SC-24).
 *
 * This list is deliberately short. A screenshot per route is not the goal —
 * the goal is the screens where a *silent* visual break costs something and
 * where the rest of the suite structurally cannot see it. Every entry names
 * the defect class it is here to catch, and each of those classes is one that
 * actually reached `main` and was found by a person looking at a browser:
 *
 * - a callout that rendered invisible because `warning` is not a colour in the
 *   Tailwind preset,
 * - a 40px control sitting on a 44px row,
 * - two Cancel buttons 80px apart,
 * - a heading over a count that contradicted it.
 *
 * None of those fail a unit test, an axe scan or a tRPC contract test. All
 * four are obvious in a pixel diff.
 *
 * The rule for what stays **out** matters as much: a screen whose content is
 * not a function of the seed does not belong here. A baseline nobody trusts
 * gets `--update`d away, which is worse than having none, because it also
 * costs the review the diff it was supposed to produce.
 *
 * **Home was excluded under that rule until SC-473, and the exclusion was
 * wrong** — worth writing down, because the reasoning looked sound. It read:
 * the hero is a net-worth chart whose x-axis is dated from the seeded
 * account's own age, so the baseline would go red every day on its own. The
 * axis is in fact dated from the *client's* clock, which `v3-screens.spec.ts`
 * has pinned since the first generation run: `homePeriodRange` windows the
 * series off `new Date()`, `page.clock.setFixedTime` makes that one instant,
 * and the request that carries it therefore asks for the same thirty days on
 * every run. What the exclusion actually described was a screen nobody had
 * pointed the harness at.
 *
 * The cost of leaving it out was not hypothetical. Three regressions shipped
 * on home and all three were found by a person looking: a figure wide enough
 * to scroll the page sideways at phone width (SC-72), home blocks that were
 * not links at all (SC-74), and totals that disagreed with each other
 * (SC-63). The first two are pixel diffs.
 *
 * **What the two seeded home baselines do NOT hold, said plainly.** The hero
 * chart is drawn with no curve in it — one point at the pinned instant, under
 * "No history for this period yet". That is the honest render for this seed
 * and it is stable for a reason worth stating rather than discovering: the
 * pinned clock is in 2027, so the window the client asks for is always ahead
 * of any rollup row a worker could have written, and a nightly
 * `portfolio-value-rollup` firing mid-run cannot move it. The frame, the
 * axis, the empty-history copy, the metric and period controls are all
 * asserted; the trace is not. Covering the trace needs rollup rows at fixed
 * dates inside that window, which only a direct write to
 * `portfolio_value_daily` can produce — `fixtures/db.ts` forbids exactly that,
 * and reversing it is a bigger decision than this ticket. Filed as its own
 * task rather than left as an unstated hole.
 */

/** The two shells v3 has. `V3Shell` switches at the `lg:` breakpoint (1024px):
 *  below it a tab bar plus a drawer, above it a sidebar. A shot of one has not
 *  looked at the other, so both are covered. */
export type VisualViewport = 'desktop' | 'phone';

/**
 * Which signed-in user a screen is photographed as (SC-473).
 *
 * `seeded` is the portfolio `fixtures/visual-setup.ts` builds and every
 * screen here used until home arrived. `empty` is a second user with nothing
 * in it, and it exists because the state that greets a new account is
 * unreachable from the first one: home renders its onboarding panel only when
 * the holdings count is zero, and the seeded user's is not. An empty-state
 * regression is the kind nobody reports, because nobody whose account has
 * data can see it.
 */
export type VisualSession = 'seeded' | 'empty';

export interface VisualScreen {
  /**
   * Baseline file stem. Renaming one orphans its PNG, which is why
   * `apps/frontend/app/tests/v3/visual-baselines.test.ts` fails on a baseline
   * with no screen and on a screen with no baseline.
   */
  name: string;
  route: string;
  /** Defaults to `seeded`; see `VisualSession`. */
  session?: VisualSession;
  viewport: VisualViewport;
  /**
   * Viewport height, in CSS pixels, for screens taller than the device.
   *
   * This is not a nicety. The v3 shell is a `100vh` column whose `<main>` is
   * the scroller, so `document` never overflows and Playwright's `fullPage`
   * option captures exactly the viewport and nothing more. Growing the
   * viewport is the only way to photograph what is below the fold — and it
   * has the better diff anyway: a fixed-size image compares pixel for pixel,
   * where a content-sized one fails as an unreadable size mismatch the first
   * time a row is added.
   *
   * Sized with headroom over the measured content height, so a small growth
   * shows up as content moving into blank space rather than as a clipped
   * baseline.
   */
  height?: number;
  /** Why a break on this screen would cost something. */
  why: string;
}

export const VISUAL_SCREENS: readonly VisualScreen[] = [
  {
    name: 'home-phone',
    route: '/',
    viewport: 'phone',
    height: 1700,
    why:
      'The screen every session lands on, in the shell it is most often read in, and the one ' +
      'place in v3 where a six-figure sum sits beside a chart, a percentage and a delta pill ' +
      'at 393px. That crowding is what SC-72 was: a figure grew wide enough to push the ' +
      'document sideways, and horizontal scroll at phone width is invisible to every other ' +
      'gate we run — axe passes, the tRPC contract holds, and the number is correct. It is ' +
      'also the only screen assembled from six independently-queried blocks, so it is where a ' +
      'block that renders to nothing (SC-74 left them all unlinked) shows up as a hole.',
  },
  {
    name: 'home-desktop',
    route: '/',
    viewport: 'desktop',
    height: 1000,
    why:
      'The same screen where its layout is genuinely different rather than merely wider: ' +
      '`DashboardGrid` only becomes a grid above `lg`, so the three-across row of allocation, ' +
      'upcoming and top holdings — and the halves beneath it — exist in this shot and in no ' +
      'other. A span that stops collapsing, or a block that spends six columns on an empty ' +
      'render, is a defect the phone baseline cannot have an opinion about.',
  },
  {
    name: 'home-empty-phone',
    route: '/',
    session: 'empty',
    viewport: 'phone',
    why:
      'What a new account is shown, which SC-451 made the product onboarding: nobody who ' +
      'has used the app can reach it, so it breaks silently and stays broken. Photographed ' +
      'in the invite state rather than the importing one — the running-import variant is a ' +
      'job in flight, and a screen that changes when the job lands is not something a ' +
      'byte-exact baseline can hold still. Phone only: the panel is a bounded card at both ' +
      'widths, and what does differ above `lg` is the shell, which the two desktop shots ' +
      'above already assert.',
  },
  {
    name: 'kitchen-sink-desktop',
    route: '/kitchen-sink',
    viewport: 'desktop',
    height: 5500,
    why:
      'The primitive gallery renders every @scani/ui primitive against the v3 tokens in both ' +
      'themes at once, with no network data behind any of it — the research brief built it as ' +
      'the screenshot target that stands in for Storybook. It is where a token or preset ' +
      'regression shows up regardless of which screen would have suffered it: an alert that ' +
      'renders as a blank box is unmissable here and easy to miss anywhere else. It is also ' +
      'the cheapest place to widen this gate — a specimen added to the gallery is covered by ' +
      'the next baseline for free.',
  },
  {
    name: 'kitchen-sink-phone',
    route: '/kitchen-sink',
    viewport: 'phone',
    height: 10_800,
    why:
      'The same gallery under `pointer: coarse`, which is the only condition where the token ' +
      'layer spends `--tap-target`. A control that measures 44px with a mouse and 40px with a ' +
      'thumb is a phone-width defect and invisible in the desktop shot.',
  },
  {
    name: 'holdings-phone',
    route: '/holdings',
    viewport: 'phone',
    why:
      'The densest list v3 has, inside the phone shell. Row height, the truncation of a long ' +
      'identity against a long figure, and the numeric column alignment are all decided here ' +
      '— and the header, tab bar and safe area come with it.',
  },
  {
    name: 'holdings-desktop',
    route: '/holdings',
    viewport: 'desktop',
    why:
      'The same list in the other shell. Above 1024px v3 is a sidebar rather than a tab bar ' +
      'and a drawer, so every phone shot in this list is blind to it.',
  },
  {
    name: 'payment-form-phone',
    route: '/payments/recurring/new',
    viewport: 'phone',
    height: 1800,
    why:
      'The only twelve-field form in the product, and forms are where duplicated or misplaced ' +
      'actions show up — a second Cancel 80px from the first is a form defect. Label-to-field ' +
      'alignment, control sizing and the disabled-submit affordance are decided here too.',
  },
];
