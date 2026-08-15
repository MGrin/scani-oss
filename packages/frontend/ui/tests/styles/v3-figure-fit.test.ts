import { describe, expect, test } from 'bun:test';
import { MODES, SCOPED } from '../helpers/v3-token-modes';

/**
 * The rule that keeps a figure inside its line (SC-72).
 *
 * A hero figure long enough to exceed the phone viewport gave `<main>` — v3's
 * scroller — a horizontal scroll, so the page slid sideways under a tab bar
 * that stayed put. `min-w-0` on the grid items could not have helped: it caps a
 * box, and an over-long figure is content spilling out of a box that is already
 * the right size.
 *
 * A regression guard rather than a value assertion, for the same reasons as
 * `v3-figure-fit`'s sibling `v3-dialog-fit.test.ts`: nothing here is visible to
 * the type checker, it protects components in a package it does not import, and
 * the symptom only appears at a viewport narrower than the content.
 *
 * Asserted against raw text, not `blocks`: `parseCss` keeps only custom
 * properties, so a plain declaration is invisible to it.
 */
describe('a figure inside v3 cannot outgrow its line', () => {
  describe.each(MODES)('%s mode', (mode, tokens) => {
    const flat = tokens.css.replace(/\s+/g, ' ');
    const scope = mode === 'scoped' ? "[data-ui='v3'] " : '';

    test('the declared line is a size container, which is what `cqi` reads', () => {
      expect(flat).toInclude(`${scope}[data-figure-line] { container-type: inline-size; }`);
    });

    test('the figure is divided down to the line, floored at the caption size', () => {
      const rule = flat.match(/\[data-figure-fit] \{[^}]*\}/)?.[0] ?? '';
      // `100cqi` is the line and `--figure-cells x advance` is the run. The
      // inset is the part of the line a fitted run does not get — the tape's
      // symbol and cents, which stay at caption size while the run shrinks.
      expect(rule).toInclude('100cqi - var(--figure-inset, 0px)');
      expect(rule).toInclude('var(--figure-cells, 1) * 0.6');
      // `min(1em, …)` caps at the size the caller asked for, so the rule only
      // ever shrinks; `max(--text-caption-size, …)` is the floor, since a
      // figure has no licence to go under v3's smallest type.
      expect(rule).toInclude('min( 1em,');
      expect(rule).toInclude('max( var(--text-caption-size),');
    });

    test('a run that has bottomed out on the floor wraps rather than overflows', () => {
      // The last resort, and the reason nothing has to truncate: `anywhere`
      // breaks a run only when it cannot fit a line of its own, so a figure
      // inline in a sentence still moves to the next line whole.
      const rule = flat.match(/\[data-figure-fit] \{[^}]*\}/)?.[0] ?? '';
      expect(rule).toInclude('overflow-wrap: anywhere;');
    });

    test('does not clip, which would hide the number instead of showing it', () => {
      // `overflow: hidden` on the shell stops the scrollbar and loses the
      // figure, which is worse than the bug. Neither rule may reach for it.
      const rules = flat.match(/\[data-figure-(?:line|fit)] \{[^}]*\}/g) ?? [];
      expect(rules).toHaveLength(2);
      for (const rule of rules) {
        expect(rule).not.toInclude('overflow: hidden');
        expect(rule).not.toInclude('text-overflow');
      }
    });
  });

  test('the scoped variant carries the scope on both of its rules', () => {
    // v2 shares a document with this file, and `container-type` on every v2
    // element that happened to carry the attribute would be a silent layout
    // change there. Counting rather than asserting absence: the scoped
    // selector contains the bare one as a substring.
    const flat = SCOPED.css.replace(/\s+/g, ' ');
    for (const attribute of ['[data-figure-line]', '[data-figure-fit]']) {
      const all = flat.split(`${attribute} {`).length - 1;
      const scoped = flat.split(`[data-ui='v3'] ${attribute} {`).length - 1;
      expect(all).toBe(1);
      expect(scoped).toBe(1);
    }
  });
});
