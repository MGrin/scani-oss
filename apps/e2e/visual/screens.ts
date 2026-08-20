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
 * not a function of the seed does not belong here. That is why the home
 * screen is absent despite being the most-visited one in the product — it is
 * a net-worth chart whose x-axis is dated from the seeded account's own age,
 * so its baseline would go red every day on its own. A baseline nobody trusts
 * gets `--update`d away, which is worse than having none, because it also
 * costs the review the diff it was supposed to produce. Covering home needs a
 * rollup fixture with fixed dates, not a mask over the only content it has.
 */

/** The two shells v3 has. `V3Shell` switches at the `lg:` breakpoint (1024px):
 *  below it a tab bar plus a drawer, above it a sidebar. A shot of one has not
 *  looked at the other, so both are covered. */
export type VisualViewport = 'desktop' | 'phone';

export interface VisualScreen {
  /**
   * Baseline file stem. Renaming one orphans its PNG, which is why
   * `apps/frontend/app/tests/v3/visual-baselines.test.ts` fails on a baseline
   * with no screen and on a screen with no baseline.
   */
  name: string;
  route: string;
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
