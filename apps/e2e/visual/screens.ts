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
type VisualViewport = 'desktop' | 'phone';

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
 *
 * `allocation` is a third user holding eight accounts, and it exists because
 * the folding allocation bar is unreachable from the seeded one: three
 * accounts is three parts, and `foldAllocation` folds only above six. Growing
 * the seeded portfolio instead would have rewritten all three home baselines
 * plus any holdings shot that gained a row, to buy coverage on one block —
 * which is the trade the "what stays out" rule above exists to refuse.
 *
 * `forecast` is a fourth user holding a book of recurring payments, for the
 * cashflow forecast (SC-623). Same reason again: recurring payments on the
 * seeded user would rewrite both of its home baselines, because home's
 * "What's due" block lists them.
 */
export type VisualSession = 'seeded' | 'empty' | 'allocation' | 'forecast';

/**
 * Every screen renders at this instant. A form that defaults a date field to
 * "today" writes today's date into its baseline, and that baseline is wrong
 * tomorrow — `/payments/recurring/new` did exactly that on the first
 * generation run. Pinning the clock removes the whole class rather than the
 * one instance, and costs nothing on a screen that never asks the time.
 *
 * Past the seeded data on purpose: the session this runs under was created
 * whenever the seed last ran, and a clock set before that would put the
 * screens in front of a session the client considers unissued.
 *
 * Exported because the forecast seed is dated from it (SC-623): its payments
 * must fall due AFTER this day, or the forecast would count them overdue.
 */
export const FIXED_NOW = new Date('2027-03-04T09:15:00Z');

/**
 * `FIXED_NOW` as the `YYYY-MM-DD` the api's forecast is pinned to.
 *
 * This is the other clock. `FIXED_NOW` pins the BROWSER's, and the forecast is
 * dated by the API's (`PaymentForecastService` starts from its own "today"),
 * so without this the runway month and the chart's axis move with the real
 * date. The spec rewrites every `payments.forecast` request on a screen that
 * declares `forecastAsOf` to carry this day, and the api honours it only on a
 * stack with `ALLOW_FORECAST_AS_OF=1` — the compose default.
 */
export const FORECAST_AS_OF = FIXED_NOW.toISOString().slice(0, 10);

/**
 * Which way the document reads (SC-760).
 *
 * RTL is a LAYOUT MODE, not a language, which is the whole reason SC-201
 * sequences it before the Arabic strings: mirroring is what makes those
 * strings legible as a page rather than word by word. So a screen declaring
 * `rtl` is photographed with English copy in a mirrored layout, and that is
 * deliberate rather than a shortcut — the copy being readable is what lets a
 * reviewer see WHAT moved instead of guessing at an unfamiliar script.
 *
 * It is also the only thing available. `<html dir>` follows the chosen
 * language, `supportedLngs` is computed from the locale directory, and there
 * is no `ar.json` yet — so no reader can select their way to `dir="rtl"` and
 * the harness sets the attribute the language would have set. The spec
 * re-reads it after the capture for that reason: an attribute set from outside
 * the app is one the app could put back, and an LTR picture filed under an RTL
 * name is a baseline that agrees with itself forever.
 */
type VisualDirection = 'rtl';

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
  /**
   * Photograph this screen with `<html dir="rtl">`; see `VisualDirection`.
   *
   * A screen with an RTL variant is declared TWICE — once without this and
   * once with it — because the pair is the artefact. One picture of a
   * mirrored layout says nothing about whether it mirrored; two say what
   * moved.
   */
  dir?: VisualDirection;
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
  /**
   * This screen draws at least one institution mark, so its baseline holds an
   * image the app fetches from a third party at render time (SC-524).
   *
   * `fixtures/visual-network.ts` serves those bytes instead of the internet,
   * and this flag is what makes the spec check the substitution *worked*
   * rather than merely happened. Without it the fix has a silent success
   * mode: an interception that fulfils with nothing, or a 404, makes
   * `FaviconImg` fall back to its letter tile — every screen still renders,
   * `--update` still produces a baseline, and the gate goes green having
   * removed the thing it was asked to hold still. So a screen declaring this
   * must show a decoded `<img>` at the pinned URL, and a run where none
   * appears fails rather than passing quietly.
   */
  institutionMark?: true;
  /**
   * This screen's allocation bar must be FOLDED — six coloured segments and an
   * "Other" standing for the rest (SC-815).
   *
   * Same job as `institutionMark` and for the same reason: without it the
   * screen has a silent success mode. A seed that quietly produced six parts
   * instead of eight still renders a bar, `--update` still writes a baseline,
   * and the gate goes green holding a picture of the state it was built to
   * rule out — the fold, `CHART_OTHER_COLOR` and the disclosed `FoldedRow`
   * tail all absent, with nothing to say so.
   *
   * A baseline that would photograph eight accounts folding and would equally
   * photograph eight NOT folding is a screenshot, not an assertion. So a
   * screen declaring this must show the fold before it is captured, and a run
   * where it does not fails rather than passing quietly.
   */
  foldedAllocation?: true;
  /**
   * This screen reads `payments.forecast`, so the api's clock has to be pinned
   * as well as the browser's — see `FORECAST_AS_OF` (SC-623).
   *
   * And checked, for the reason `institutionMark` is: a rewrite that silently
   * stopped matching, or a stack with the flag off, still renders a forecast —
   * one dated from the real day. `--update` would write it and every run that
   * month would agree. So the spec reads the `today` of every forecast the page
   * received and fails unless each is `FORECAST_AS_OF`.
   */
  forecastAsOf?: true;
  /**
   * Photograph this one element rather than the page.
   *
   * For a component whose neighbours are not a function of the seed. Home's
   * runway line sits under "What's due", whose rows come from
   * `payments.upcoming` — dated by the api's clock, which `asOf` does not move.
   * Photographing the page would hold those rows too, and they change every
   * month. The width is the element's, not the viewport's.
   */
  element?: string;
  /** Why a break on this screen would cost something. */
  why: string;
}

/**
 * `viewPreferenceStorageKey('home.allocation-dimension')` as the app writes it,
 * and the cut the folding baseline is taken on.
 *
 * Duplicated rather than imported: this workspace does not depend on
 * `apps/frontend/app` and `fixtures/v3-routes.ts` keeps route literals here for
 * the same reason. They are pinned against the app's own constants by
 * `apps/frontend/app/tests/v3/visual-baselines.test.ts`, which already reads
 * this file — so a rename fails a unit test in under a second instead of
 * surviving as a two-minute Docker run that photographs the wrong cut.
 *
 * That is not hypothetical. The first run of this screen used `v3:` as the
 * prefix, seeded nothing, and photographed the DEFAULT `token_type` cut — one
 * segment, all USD, the exact baseline SC-815 exists to replace. It was caught
 * by `foldedAllocation`'s assertion rather than by review.
 */
export const ALLOCATION_DIMENSION_STORAGE_KEY = 'scani.v3.view.home.allocation-dimension';

/** NOT the default (`token_type`), which cannot fold on this seed: five token
 *  types exist and all 136 tokens migration `0000` seeds are fiat, so that cut
 *  has one part (SC-820). */
export const FOLDING_DIMENSION = 'account';

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
    name: 'home-allocation-fold-desktop',
    route: '/',
    session: 'allocation',
    viewport: 'desktop',
    height: 1400,
    foldedAllocation: true,
    why:
      'The only baseline in which the allocation bar has more than one segment. Until SC-815 ' +
      'every seeded account held USD, so every committed picture of this block was a ' +
      "one-segment 100% bar — and `foldAllocation`'s six-slot colour ramp, the cap, " +
      '`CHART_OTHER_COLOR` and the disclosed `FoldedRow` tail were asserted by no pixel ' +
      "anywhere. `AllocationBlock`'s docblock argues that cap at length: slots 7 and 8 carry " +
      "`--interactive`'s and `--loss`'s hues, so a seventh coloured part reads as a button or " +
      'as a falling figure. That is a claim about colour whose violation fails no unit test, ' +
      'no axe scan and no contract test, and is obvious in a pixel diff — the exact charter ' +
      'stated at the top of this file, unmet for the component most plainly in its remit. ' +
      'Cut by ACCOUNT rather than by token type: five token types exist and all 136 seeded ' +
      'tokens are fiat, so seven types is unreachable without a live CoinGecko sync (SC-820).',
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
    institutionMark: true,
    why:
      'The densest list v3 has, inside the phone shell. Row height, the truncation of a long ' +
      'identity against a long figure, and the numeric column alignment are all decided here ' +
      '— and the header, tab bar and safe area come with it.',
  },
  {
    name: 'holdings-desktop',
    route: '/holdings',
    viewport: 'desktop',
    institutionMark: true,
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
  // --- the cashflow forecast (SC-623) ------------------------------------------
  //
  // SC-461's whole constraint is that a projection never looks like a measured
  // figure: dashed `<Block>` borders, `<ProjectedTile>` rather than
  // `<StatTile>`, a dashed neutral chart line with no fill. That claim is all
  // presentation, so a type-check and a unit test cannot see it. The seed runs
  // out of money inside the window, so the runway is a DATE — the exhausted
  // branch, the only one with the zero reference line and `--loss`.
  {
    name: 'forecast-phone',
    route: '/payments/forecast',
    session: 'forecast',
    viewport: 'phone',
    height: 1700,
    forecastAsOf: true,
    why:
      'The one screen whose every figure is a projection, at the width where a dashed border ' +
      'and a solid one are two pixels apart. A stylesheet change that makes the two look ' +
      'alike passes `forecast.test.tsx`, which asserts the class name, and is plain here.',
  },
  {
    name: 'forecast-desktop',
    route: '/payments/forecast',
    session: 'forecast',
    viewport: 'desktop',
    height: 1300,
    forecastAsOf: true,
    why:
      'The same screen with room for the chart: the month axis, the dashed projection line and ' +
      'the zero reference line it crosses are drawn at full width only here.',
  },
  {
    name: 'home-runway-phone',
    route: '/',
    session: 'forecast',
    viewport: 'phone',
    element: '[data-ui="runway-line"]',
    forecastAsOf: true,
    why:
      "Home's one projected line: a dashed rule and a Projected mark under two solid foot-lines, " +
      'on the screen a reader scans rather than reads. Photographed as an element because the ' +
      "rows above it are dated by the api's clock, which this gate cannot pin.",
  },
  // --- the RTL pass (SC-760) -------------------------------------------------
  //
  // Three screens rather than eight, chosen so that between them they cover
  // every category the ticket names — nav, tables, charts and the sheet — and
  // so that a reviewer has a bounded set of image pairs to actually look at.
  // A mirrored baseline nobody reviews is worth less than none, for the same
  // reason `screens.ts` keeps the LTR list short.
  {
    name: 'kitchen-sink-desktop-rtl',
    route: '/kitchen-sink',
    viewport: 'desktop',
    height: 5500,
    dir: 'rtl',
    why:
      'The highest-value RTL shot in the product, and the reason is the same one that makes it ' +
      'the highest-value LTR shot: it renders every @scani/ui primitive at once, with no network ' +
      'data behind any of it. SC-760 converted 166 physical utilities to logical ones across the ' +
      'design system, and the ones that matter are all here — the alert whose icon is absolutely ' +
      'positioned against its text, the select whose check indicator sits at the leading edge, ' +
      'the table whose numeric columns align to the trailing one. A logical utility that is ' +
      'wrong is not a crash and not a type error; it is a control whose padding is on the ' +
      'opposite side, which is visible here and nowhere else.',
  },
  {
    name: 'home-phone-rtl',
    route: '/',
    viewport: 'phone',
    height: 1700,
    dir: 'rtl',
    why:
      'The shell, mirrored — the tab bar, the header and the six home blocks, at the width where ' +
      'the layout has least room to absorb a mistake. It is also the one screen in this list ' +
      'with a chart in it, and a chart is drawn from coordinates rather than from utilities, so ' +
      'it is where mirroring is most likely to be INCOMPLETE rather than wrong: the frame and ' +
      'the axis follow the document, the plotted series does not. The pair is what shows that.',
  },
  {
    name: 'holdings-desktop-rtl',
    route: '/holdings',
    viewport: 'desktop',
    dir: 'rtl',
    institutionMark: true,
    why:
      'The densest table in the product, in the sidebar shell. Two things are decided here and ' +
      'nowhere else: that the sidebar moves to the trailing edge, and that a numeric column ' +
      'stays readable when the axis it aligns against reverses. A figure column that follows ' +
      'the text direction is a table of numbers nobody can scan.',
  },
  {
    name: 'payment-form-phone-rtl',
    route: '/payments/recurring/new',
    viewport: 'phone',
    height: 1800,
    dir: 'rtl',
    why:
      'The only RTL shot of a FORM, which is its own layout class: the three above cover nav, ' +
      'tables, charts and the sheet, and none of them puts a label beside a field. ' +
      'Label-to-field alignment is the most direction-sensitive layout there is, and it fails ' +
      'at phone width, where labels wrap and controls shrink — not in the kitchen sink, where ' +
      'the same controls stand alone on a demo page (SC-970).',
  },
];
