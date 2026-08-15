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
 * The house touch-target rule: 44×44 CSS px on anything a finger points at.
 *
 * Deliberately measured rather than asserted from class names — the v3 rule
 * lives in the token layer behind `@media (pointer: coarse)` and applies to
 * elements that carry no class saying so, which is exactly why the previous
 * attempt to check this by grepping `min-h-tap` found nothing and shipped a
 * 28px control anyway.
 *
 * Three exemptions, each because the control reaches its hit area somewhere
 * other than its own box:
 * - `[role=checkbox|radio|switch]` grow their target through the label beside
 *   them; the token layer excludes them for the same reason.
 * - An anchor inside a paragraph is an inline link — WCAG 2.2 SC 2.5.8's own
 *   "inline" exception.
 * - `[data-a11y-target=inline]` is the opt-out for the same case where the
 *   markup is not a `<p>`; it has to be spelled out at the call site.
 */
export async function measureUndersizedTargets(
  page: Page,
  surface: string,
  minimum = 44
): Promise<Measured<TargetMeasurement>> {
  return page.evaluate(
    ({ surface: label, minimum: floor }) => {
      const empty = { scanned: 0, offenders: [] };
      const scope = document.querySelector('[data-ui="v3"]');
      if (!scope) return empty;

      const INTERACTIVE = 'button, a[href], [role="button"], [role="tab"], summary';
      const EXEMPT =
        '[role="checkbox"], [role="radio"], [role="switch"], [data-a11y-target=inline]';

      function describe(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const name =
          element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';
        return `${tag}${name ? ` "${name}"` : ''}`;
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
    { surface, minimum }
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
