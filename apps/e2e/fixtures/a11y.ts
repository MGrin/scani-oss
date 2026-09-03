import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * The accessibility gate for v3 (§2.6 of the research brief).
 *
 * axe covers the rows of that table a machine can decide — text contrast,
 * non-text contrast, accessible names, landmark and heading structure. The
 * three rows it cannot see are checked next to it in the same spec:
 *
 * - **Touch targets** — `measureUndersizedTargets` below, run at a phone
 *   viewport so the `pointer: coarse` branch of the v3 token layer is the one
 *   under test. axe's own `target-size` rule is WCAG 2.2's 24px floor; the
 *   house rule is 44.
 * - **Minimum font on inputs** — `measureSmallInputs` below. iOS zooms any
 *   focused control under 16px, which axe has no opinion about.
 * - **Colour never alone** — enforced statically by `<Numeric>` and asserted
 *   in `apps/frontend/app/tests/v3/`; nothing in the DOM distinguishes "red
 *   because loss" from "red because brand".
 */

/**
 * WCAG 2.2 AA and everything it subsumes. `best-practice` is deliberately
 * excluded: it carries rules that are opinions rather than conformance
 * failures (region, page-has-heading-one), and a gate that fails on an
 * opinion gets disabled within a month.
 */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Impacts that fail the build. `critical` is the ticket's floor; `serious`
 * is included because the two rows of §2.6 axe actually decides — text and
 * non-text contrast — both report as `serious`, and a contrast gate that
 * ignores them would gate nothing.
 */
export const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['critical', 'serious']);

export interface A11yFinding {
  surface: string;
  ruleId: string;
  impact: string;
  help: string;
  nodes: string[];
}

/**
 * Run axe over the current page and return the findings that fail the gate.
 *
 * Scoped to the v3 token scope rather than the whole document: `<body>` also
 * carries the update banner and the install prompt, which are v2-era shared
 * components mounted above the router (see `V3Shell`), and this ticket does
 * not own them.
 */
export async function scanSurface(page: Page, surface: string): Promise<A11yFinding[]> {
  const results = await new AxeBuilder({ page })
    .include('[data-ui="v3"]')
    .withTags(WCAG_TAGS)
    .analyze();

  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({
      surface,
      ruleId: violation.id,
      impact: violation.impact ?? 'unknown',
      help: violation.help,
      // The selector alone is close to useless when the offender is a Radix
      // primitive — `button[aria-controls="radix-:r13:"]` names an element
      // whose id is regenerated every render. The markup says which component
      // it is.
      nodes: violation.nodes.map(
        (node) => `${node.target.join(' ')}\n      ${node.html.slice(0, 200)}`
      ),
    }));
}

export function formatFindings(findings: A11yFinding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.surface} — [${finding.impact}] ${finding.ruleId}: ${finding.help}\n` +
        finding.nodes.map((node) => `    ${node}`).join('\n')
    )
    .join('\n');
}

export interface TargetMeasurement {
  surface: string;
  selector: string;
  width: number;
  height: number;
}

/**
 * `scanned` is not diagnostics — it is the assertion that keeps the two
 * measurements below from passing for the wrong reason. Both answer "how many
 * offenders", and zero offenders is also what a page with no controls on it
 * returns, which is what a failed seed or a skeleton that never resolved looks
 * like. The caller asserts on it.
 */
export interface Measured<T> {
  scanned: number;
  offenders: T[];
}

/**
 * What the walk measures — and why it is built from vocabularies this product
 * does not own, rather than from a list of the controls it happens to ship.
 *
 * Until SC-989 this was `button, a[href], [role="button"], [role="tab"],
 * summary`: five shapes chosen by looking at v3. An element outside that set
 * was not measured, and **"not measured" reports identically to "no
 * offenders"** — the `scanned` floor below is a liveness check on the walk,
 * not a per-element claim, so a control the query never matches contributes
 * nothing to it either. The v3 token layer's `@media (pointer: coarse)` block
 * is an allow-list of the same shape, kept in a file that does not reference
 * this one, so a control type missing from BOTH gets no 44px floor AND no
 * measurement. `<select>` was missing from both, and shipped at 36px on a
 * phone through the gate that exists to find 36px targets (SC-978).
 *
 * A longer list of the same kind is not the repair. Two enumerations agreeing
 * is not coverage — they would agree on being equally incomplete, and the next
 * control type nobody thought of repeats the failure exactly. So the default
 * is inverted: unknown is MEASURED rather than invisible, and the query is
 * assembled from two closed vocabularies that do not grow when this product
 * does — HTML's own interactive elements, and the ARIA widget roles that name
 * a discrete pointer target — plus anything the author has put in the tab
 * order, which is how a `<div>` becomes a control without adopting either.
 *
 * This is also why the token layer's list is NOT derived from this one, and
 * why no test asserts that the two agree. They answer different questions.
 * The token layer decides what to GIVE a floor to, and is necessarily narrow:
 * a blanket `min-height` inflates inline links, checkboxes and table rows into
 * slabs, which is the regression its neutraliser block exists to undo. This
 * decides what to MEASURE, and being wider is the point — a control the token
 * layer does not reach either clears 44px on its own geometry or turns the
 * walk red. **The walk is the backstop for the CSS list, not its mirror**, and
 * that is what makes a future omission from the CSS loud instead of silent.
 *
 * `select` IS THE CASE THAT PROVES THE TWO LISTS MUST BE ALLOWED TO DIFFER,
 * and it is why "widen both together" was the wrong instinct. Adding `select`
 * to the token layer was tried first and does nothing: `min-height` does not
 * floor a native `<select>` in WebKit — measured 2026-09-03 against this
 * repo's compiled stylesheet in an `iPhone 15 Pro` context, the rule matched,
 * it was the only `min-height` declaration on the element, and the computed
 * value was **18px**; an inline `min-height: 44px` computed 18px as well, and
 * only `appearance: none` restored it. A `select` entry there would be a floor
 * that reads as present and is inert, which is this ticket's own defect one
 * level up. So the walk measures `select` and the token layer does not floor
 * it: the remedy at a call site is `@scani/ui`'s `Select`, whose trigger is a
 * `<button>`, which is what `token-hygiene.test.ts` already requires.
 */
export const INTERACTIVE_TARGETS = [
  // HTML's interactive elements. `input[type=hidden]` is the only type with
  // no box at all; every other one is a target or is exempted below on its
  // own merits, which is the fail-closed half of this list.
  'button',
  'a[href]',
  'select',
  'textarea',
  'summary',
  'input:not([type="hidden"])',
  '[contenteditable]:not([contenteditable="false"])',

  // The ARIA widget roles that name a DISCRETE pointer target. The container
  // and output roles are deliberately absent — `tablist`, `radiogroup`,
  // `menu`, `listbox`, `grid`, `dialog`, `progressbar` and `status` have
  // nothing to hit, and their children are what this list names instead. So
  // are `scrollbar` and a focusable `separator`: both are dragged rather than
  // tapped, and both are sized by the region they operate on, so a 44px floor
  // on either would be a claim about the wrong box.
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',

  // Anything the author put in the tab order itself and gave NO role. This is
  // the arm that catches a control belonging to neither vocabulary — a `<div>`
  // with a click handler and `tabIndex={0}` is a target, and nothing above
  // would see it.
  //
  // Negative values are excluded: `tabIndex={-1}` marks an element that is
  // focusable only programmatically, which every Radix overlay and every
  // nested link inside an already-clickable row uses precisely to say "the hit
  // target is not me".
  //
  // `:not([role])` is the measured half. Focus is not the same claim as
  // touch: WCAG 2.1.1 puts a CONTAINER in the tab order so a keyboard can
  // reach what is inside it, and Radix's `TabsContent` and the `ScrollArea`
  // viewport both do exactly that. The first widened walk reported
  // `div[role=tabpanel] "12 positions across 4 institutions." is 327×24` —
  // a paragraph of text, reported as an undersized tap target. So where the
  // author has named a role, the role vocabulary above has ALREADY decided
  // whether the element is a target, and this arm defers to it rather than
  // overriding it with a growing list of exemptions.
  '[tabindex]:not([tabindex^="-"]):not([role])',
].join(', ');

/**
 * Exempt, each because the control reaches its hit area somewhere other than
 * its own box:
 * - `[role=checkbox|radio|switch]` grow their target through the label beside
 *   them; the token layer excludes them for the same reason.
 * - `input[type=checkbox|radio]` are the native spelling of the same two, and
 *   have to be named separately because `matches()` reads the ATTRIBUTE: an
 *   `<input type="radio">` carries the implicit role and does not match
 *   `[role="radio"]`. The token layer already treats them this way — its
 *   neutraliser returns both to `min-height: 0` and the `pointer: coarse`
 *   block does not float them again.
 * - An anchor inside a paragraph is an inline link — WCAG 2.2 SC 2.5.8's own
 *   "inline" exception.
 * - `[data-a11y-target=inline]` is the opt-out for the same case where the
 *   markup is not a `<p>`; it has to be spelled out at the call site.
 *
 * Nothing is exempted here speculatively. A control type that is not rendered
 * today cannot be shown to need an exemption, and pre-writing one would put
 * the fail-closed default back where it started — the next one to arrive
 * should turn the walk red and be argued then, which is the whole design.
 */
export const EXEMPT_TARGETS = [
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[data-a11y-target=inline]',
].join(', ');

/**
 * The house touch-target rule: 44×44 CSS px on anything a finger points at.
 *
 * Deliberately measured rather than asserted from class names — the v3 rule
 * lives in the token layer behind `@media (pointer: coarse)` and applies to
 * elements that carry no class saying so, which is exactly why the previous
 * attempt to check this by grepping `min-h-tap` found nothing and shipped a
 * 28px control anyway.
 */
export async function measureUndersizedTargets(
  page: Page,
  surface: string,
  minimum = 44
): Promise<Measured<TargetMeasurement>> {
  return page.evaluate(
    ({ surface: label, minimum: floor, interactive: INTERACTIVE, exempt: EXEMPT }) => {
      const empty = { scanned: 0, offenders: [] };
      const scope = document.querySelector('[data-ui="v3"]');
      if (!scope) return empty;

      function describe(element: Element): string {
        const tag = element.tagName.toLowerCase();
        // The role and the input type are what say which arm of the query
        // matched. A widened query reports `div` for a menu item, an option
        // and a slider alike, and a name is not always there to tell them
        // apart — the offender then reads as "some div", which is the one
        // description nobody can act on.
        const role = element.getAttribute('role');
        const type = tag === 'input' ? element.getAttribute('type') : null;
        const name =
          element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';
        return `${tag}${type ? `[type=${type}]` : ''}${role ? `[role=${role}]` : ''}${
          name ? ` "${name}"` : ''
        }`;
      }

      const offenders: Array<{
        surface: string;
        selector: string;
        width: number;
        height: number;
      }> = [];
      let scanned = 0;

      for (const element of scope.querySelectorAll(INTERACTIVE)) {
        if (element.matches(EXEMPT) || element.closest(EXEMPT)) continue;
        if (element.closest('p, li, [data-a11y-target=inline]') && element.tagName === 'A')
          continue;
        const rect = element.getBoundingClientRect();
        // Zero-area elements are not rendered (a collapsed drawer, an
        // `aria-hidden` spacer); they are not targets and have no size to owe.
        if (rect.width === 0 || rect.height === 0) continue;
        scanned++;
        if (rect.width >= floor && rect.height >= floor) continue;
        offenders.push({
          surface: label,
          selector: describe(element),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
      return { scanned, offenders };
    },
    { surface, minimum, interactive: INTERACTIVE_TARGETS, exempt: EXEMPT_TARGETS }
  );
}

export interface FontMeasurement {
  surface: string;
  selector: string;
  fontSize: number;
}

/**
 * iOS Safari zooms the viewport when a control under 16px takes focus, and
 * never zooms back. §2.6's last row. Text-entry controls only: a checkbox has
 * no text to size, and a `<select>` opens a platform picker rather than
 * focusing the field.
 */
const TEXT_ENTRY_SELECTOR =
  'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=color]):not([type=file]), textarea';

export async function measureSmallInputs(
  page: Page,
  surface: string,
  minimum = 16
): Promise<Measured<FontMeasurement>> {
  return page.evaluate(
    ({ surface: label, minimum: floor, selector }) => {
      const empty = { scanned: 0, offenders: [] };
      const scope = document.querySelector('[data-ui="v3"]');
      if (!scope) return empty;

      const offenders: Array<{ surface: string; selector: string; fontSize: number }> = [];
      let scanned = 0;
      for (const element of scope.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        scanned++;
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
        if (fontSize >= floor) continue;
        const type = element.getAttribute('type');
        offenders.push({
          surface: label,
          selector: `${element.tagName.toLowerCase()}${type ? `[type=${type}]` : ''}`,
          fontSize,
        });
      }
      return { scanned, offenders };
    },
    { surface, minimum, selector: TEXT_ENTRY_SELECTOR }
  );
}
