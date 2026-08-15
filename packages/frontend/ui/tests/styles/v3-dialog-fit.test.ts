import { describe, expect, test } from 'bun:test';
import { MODES, SCOPED } from '../helpers/v3-token-modes';

/**
 * The rule that keeps a dialog inside the screen (SC-70).
 *
 * `DialogContent` is a grid whose single implicit column is an `auto` track,
 * and an `auto` track's automatic minimum is its widest item's min-content. So
 * one oversized child sized the whole track past the viewport and dragged every
 * sibling grid item with it — which is how a v2 dialog reached from v3 put its
 * primary action off the right edge of a phone, with the v3 root's
 * `overflow: hidden` leaving nothing to scroll to reach it.
 *
 * A regression guard rather than a value assertion: nothing about the rule is
 * visible to the type checker, it protects components in a package it does not
 * import, and the symptom only appears at a viewport narrower than the content
 * — which is to say, never on the machine of whoever would delete it.
 *
 * Asserted against raw text, not `blocks`: `parseCss` keeps only custom
 * properties, so a plain declaration is invisible to it (same reason as the
 * tap-area rules in `v3-tokens.test.ts`).
 */
describe('a dialog inside v3 cannot outgrow the screen', () => {
  describe.each(MODES)('%s mode', (mode, tokens) => {
    const flat = tokens.css.replace(/\s+/g, ' ');
    const selector = mode === 'scoped' ? "[data-ui='v3'] [role='dialog']" : "[role='dialog']";

    test('caps the dialog track at the container with a zero floor', () => {
      // `minmax(0, 1fr)` and nothing else. `1fr` alone keeps the automatic
      // minimum and therefore fixes nothing, which is the plausible wrong edit.
      expect(flat).toInclude(`${selector} { grid-template-columns: minmax(0, 1fr); }`);
    });
  });

  test('does not set max-width, which would blow the side sheets open', () => {
    // At (0,2,0) this selector outranks `sm:max-w-sm`, so a `max-width` here
    // would silently widen every Sheet to the full viewport — and it would not
    // fix the overflow anyway, because the box was never the thing that was
    // too big.
    const rule = SCOPED.css.match(/\[data-ui='v3'] \[role='dialog'] \{[^}]*\}/)?.[0] ?? '';
    expect(rule).not.toInclude('max-width');
  });

  test('the scoped variant carries the scope on its only occurrence', () => {
    // v2 shares a document with this file, so an unprefixed copy of the rule
    // would reach v2's dialogs too. Counting rather than asserting absence:
    // the scoped selector *contains* the bare one as a substring, so "does not
    // include" can never be true here.
    const flat = SCOPED.css.replace(/\s+/g, ' ');
    const all = flat.split("[role='dialog'] { grid-template-columns").length - 1;
    const scoped = flat.split("[data-ui='v3'] [role='dialog'] { grid-template-columns").length - 1;
    expect(all).toBe(1);
    expect(scoped).toBe(1);
  });
});
