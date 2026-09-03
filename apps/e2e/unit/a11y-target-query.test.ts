import { describe, expect, test } from 'bun:test';
import { EXEMPT_TARGETS, INTERACTIVE_TARGETS } from '../fixtures/a11y';

/**
 * That the touch-target walk's query is as wide as SC-989 decided it is.
 *
 * The defect this pins is a query that does not match, and a query that does
 * not match is SILENT: `measureUndersizedTargets` reports offenders, and an
 * element it never selected contributes nothing to the offender list AND
 * nothing to the `scanned` liveness floor beside it. So "the walk measured no
 * `<select>`" and "there is no undersized `<select>`" are the same reading,
 * which is how a 36px control passed the §2.6 gate on every run for as long
 * as it shipped (SC-978).
 *
 * It belongs in `unit/` for the reason `stability.test.ts` and
 * `capture-size.test.ts` give: this directory is the one place the root `test`
 * script can point at without sweeping `apps/e2e/tests/`'s Playwright specs
 * into `bun test`. That matters here more than usual — the walk itself needs
 * Docker, a compose stack and a WebKit phone context, so it is not in the
 * gate, and without this the widened query is checked by nothing a person
 * runs before pushing.
 *
 * WHAT THIS IS NOT. `HTMLRewriter` is lol-html, not the browser's selector
 * engine, so agreement here is not proof of agreement in WebKit. It is a
 * regression pin on the SET — delete `select` from the query and this goes
 * red — and the instrument of record stays the walk. The selectors below were
 * additionally run against a real iPhone context in the SC-989 probe run,
 * with a planted 36px `<select>` and a planted 36px `<button>`: before the
 * widening only the button was reported, after it both were.
 *
 * Every arm has its counterpart. A query of `*` passes every must-match
 * assertion perfectly, and an exemption list of `*` would empty the walk
 * without failing one of them either — so the must-NOT-match block below is
 * not thoroughness, it is the half that can fail.
 */

function matchCount(selector: string, html: string): number {
  let count = 0;
  new HTMLRewriter()
    .on(selector, {
      element() {
        count += 1;
      },
    })
    .transform(html);
  return count;
}

function matched(selector: string, html: string): boolean {
  return matchCount(selector, html) > 0;
}

/** The controls the walk must measure, each with why it is in the list. */
const MEASURED: ReadonlyArray<readonly [string, string]> = [
  // The five the query had before SC-989 — the control on everything below,
  // because a widening that dropped one of these would be a regression the
  // must-NOT-match block could never see.
  ['button', '<button>go</button>'],
  ['a[href]', '<a href="/holdings">holdings</a>'],
  ['[role=button]', '<div role="button">go</div>'],
  ['[role=tab]', '<div role="tab">tab</div>'],
  ['summary', '<details><summary>more</summary></details>'],

  // The element this ticket is about.
  ['select', '<select><option>one</option></select>'],

  // The rest of HTML's interactive elements.
  ['textarea', '<textarea></textarea>'],
  ['input[type=text]', '<input type="text">'],
  ['input[type=date]', '<input type="date">'],
  ['input with no type', '<input>'],
  ['contenteditable', '<div contenteditable="true">x</div>'],
  ['bare contenteditable', '<div contenteditable>x</div>'],

  // The ARIA widget roles that name a discrete pointer target. A Radix
  // `SelectTrigger` is a `<button>` and was always measured; a `SelectItem`,
  // a `DropdownMenuItem` and a `CommandItem` are `<div>`s carrying one of
  // these, and none of them was.
  ['[role=combobox]', '<div role="combobox">pick</div>'],
  ['[role=option]', '<div role="option">one</div>'],
  ['[role=menuitem]', '<div role="menuitem">rename</div>'],
  ['[role=menuitemcheckbox]', '<div role="menuitemcheckbox">show</div>'],
  ['[role=menuitemradio]', '<div role="menuitemradio">daily</div>'],
  ['[role=link]', '<div role="link">open</div>'],
  ['[role=slider]', '<div role="slider"></div>'],
  ['[role=spinbutton]', '<div role="spinbutton"></div>'],
  ['[role=searchbox]', '<div role="searchbox"></div>'],
  ['[role=textbox]', '<div role="textbox"></div>'],
  ['[role=treeitem]', '<div role="treeitem">node</div>'],

  // Matched here and exempted below — the two lists have to be read together,
  // and an element that is exempt must first be one the walk selects, or the
  // exemption is describing something that was never there.
  ['[role=checkbox]', '<div role="checkbox"></div>'],
  ['[role=radio]', '<div role="radio"></div>'],
  ['[role=switch]', '<div role="switch"></div>'],

  // The arm that catches a control belonging to neither vocabulary.
  ['tabindex=0 with no role', '<div tabindex="0">clickable</div>'],
];

/**
 * What the walk must NOT measure. Two kinds, and both are load-bearing:
 * roles that describe a container or an output have no box to hit, and an
 * element the author has explicitly removed from the tab order is saying the
 * hit target is somewhere else.
 */
const NOT_MEASURED: ReadonlyArray<readonly [string, string]> = [
  ['[role=status]', '<div role="status">saved</div>'],
  ['[role=alert]', '<div role="alert">failed</div>'],
  ['[role=img]', '<div role="img"></div>'],
  ['[role=progressbar]', '<div role="progressbar"></div>'],
  ['[role=presentation]', '<div role="presentation"></div>'],
  ['[role=application]', '<div role="application"></div>'],
  ['[role=dialog]', '<div role="dialog"></div>'],
  ['[role=tablist]', '<div role="tablist"></div>'],
  ['[role=radiogroup]', '<div role="radiogroup"></div>'],
  ['[role=listbox]', '<div role="listbox"></div>'],
  ['[role=menu]', '<div role="menu"></div>'],
  ['[role=grid]', '<div role="grid"></div>'],
  ['[role=gridcell]', '<div role="gridcell"></div>'],
  // Dragged rather than tapped, and sized by the region they operate on.
  ['[role=scrollbar]', '<div role="scrollbar"></div>'],
  ['[role=separator]', '<div role="separator" tabindex="-1"></div>'],

  ['input[type=hidden]', '<input type="hidden">'],
  ['contenteditable=false', '<div contenteditable="false">x</div>'],
  ['tabindex=-1', '<div tabindex="-1">focus target</div>'],
  ['an anchor with no href', '<a>not a link</a>'],
  ['a plain span', '<span>text</span>'],

  // Focus is not the same claim as touch. WCAG 2.1.1 puts a CONTAINER in the
  // tab order so a keyboard can reach what is inside it, and both of these do
  // — Radix's `TabsContent` and the `ScrollArea` viewport. The first widened
  // walk reported the tabpanel as a 327×24 tap target, which is a paragraph of
  // text. Where a role is named, the role list decides.
  ['a focusable tabpanel', '<div role="tabpanel" tabindex="0">12 positions</div>'],
  ['a focusable region', '<div role="region" tabindex="0">scrollable</div>'],
];

describe('INTERACTIVE_TARGETS', () => {
  test.each(MEASURED)('measures %s', (_label, html) => {
    expect(matched(INTERACTIVE_TARGETS, html)).toBe(true);
  });

  test.each(NOT_MEASURED)('does not measure %s', (_label, html) => {
    expect(matched(INTERACTIVE_TARGETS, html)).toBe(false);
  });

  /**
   * SC-989 in one line. The five-selector query this replaced is spelled out
   * rather than imported, so the assertion is against the historical defect
   * and cannot follow the constant it is checking.
   */
  test('the pre-SC-989 query could not see a select — the defect, reproduced', () => {
    const before = 'button, a[href], [role="button"], [role="tab"], summary';
    const undersizedSelect = '<select class="h-9"><option>36px</option></select>';
    expect(matched(before, undersizedSelect)).toBe(false);
    expect(matched(INTERACTIVE_TARGETS, undersizedSelect)).toBe(true);
  });
});

describe('EXEMPT_TARGETS', () => {
  /**
   * Each of these reaches its hit area somewhere other than its own box, and
   * the token layer excludes each for the same reason. The native pair is
   * named separately from the roles because `matches()` reads the ATTRIBUTE:
   * an `<input type="radio">` carries the implicit role and does not match
   * `[role="radio"]`.
   */
  test.each([
    ['[role=checkbox]', '<div role="checkbox"></div>'],
    ['[role=radio]', '<div role="radio"></div>'],
    ['[role=switch]', '<div role="switch"></div>'],
    ['input[type=checkbox]', '<input type="checkbox">'],
    ['input[type=radio]', '<input type="radio">'],
    ['the explicit opt-out', '<div data-a11y-target="inline">link</div>'],
  ] as const)('exempts %s', (_label, html) => {
    expect(matched(EXEMPT_TARGETS, html)).toBe(true);
  });

  /**
   * The exemption list is subtracted from every measurement, so one that grew
   * a selector too wide would empty the walk while every must-match assertion
   * above still passed. These are the controls it must never reach.
   */
  test.each([
    ['a button', '<button>go</button>'],
    ['a select', '<select><option>one</option></select>'],
    ['a text input', '<input type="text">'],
    ['a link', '<a href="/holdings">holdings</a>'],
    ['a menu item', '<div role="menuitem">rename</div>'],
  ] as const)('does not exempt %s', (_label, html) => {
    expect(matched(EXEMPT_TARGETS, html)).toBe(false);
  });
});
