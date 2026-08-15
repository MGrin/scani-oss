import { describe, expect, test } from 'bun:test';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The v3 destructive-confirm pattern (V3-31).
 *
 * `renderToStaticMarkup` gives one frame at a time, so `open` is passed as
 * a prop rather than driven by a click — which is the reason `ConfirmAction`
 * is a controlled component in the first place: the closed frame and the
 * open frame are both assertable, and its parents need to reset a chooser
 * on cancel anyway.
 *
 * The two rules asserted below are the ones a future destructive action
 * would otherwise re-litigate, so they are pinned rather than described.
 */

const BASE = {
  label: 'End',
  confirmLabel: 'End this payment',
  consequence: 'Ends Hetzner on Aug 13, 2026.',
  onConfirm: () => {},
  onOpenChange: () => {},
};

function order(markup: string, ...needles: string[]): number[] {
  return needles.map((needle) => markup.indexOf(needle));
}

describe('ConfirmAction', () => {
  test('rests as a single button, with no consequence text taking up room', () => {
    const markup = renderToStaticMarkup(<ConfirmAction {...BASE} open={false} />);
    expect(markup).toContain('End');
    expect(markup).not.toContain('Ends Hetzner');
    expect(markup).not.toContain('Cancel');
  });

  test('states the consequence before a commit button exists to press', () => {
    const markup = renderToStaticMarkup(<ConfirmAction {...BASE} open />);
    const [consequence, commit] = order(markup, 'Ends Hetzner', 'End this payment');
    expect(consequence).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(consequence);
  });

  /**
   * Rule 1. The reason a confirm can be inline at all: the commit must not
   * land under the finger that just tapped the trigger. Cancel leads, so a
   * double-tap on a stale target cancels and cannot destroy.
   */
  test('Cancel comes before the commit, so a double-tap cancels', () => {
    const markup = renderToStaticMarkup(<ConfirmAction {...BASE} open />);
    const [cancel, commit] = order(markup, 'Cancel', 'End this payment');
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(commit);
  });

  /** Rule 2. A different label makes the second tap a different act. */
  test('the commit is not labelled like the trigger', () => {
    expect(BASE.confirmLabel).not.toBe(BASE.label);
    const markup = renderToStaticMarkup(<ConfirmAction {...BASE} open />);
    expect(markup).toContain('End this payment');
  });

  test('destructive paints the commit, and is off by default', () => {
    const plain = renderToStaticMarkup(<ConfirmAction {...BASE} open />);
    const dangerous = renderToStaticMarkup(<ConfirmAction {...BASE} open destructive />);
    expect(plain).not.toContain('bg-destructive');
    expect(dangerous).toContain('bg-destructive');
  });

  test('a chooser renders above the consequence it decides', () => {
    const markup = renderToStaticMarkup(
      <ConfirmAction {...BASE} open chooser={<span>pick-a-vendor</span>} />
    );
    const [chooser, consequence] = order(markup, 'pick-a-vendor', 'Ends Hetzner');
    expect(chooser).toBeGreaterThan(-1);
    expect(chooser).toBeLessThan(consequence);
  });

  test('the commit is disabled until there is something to agree to', () => {
    const markup = renderToStaticMarkup(<ConfirmAction {...BASE} open canConfirm={false} />);
    expect(markup).toContain('disabled');
  });

  /**
   * SC-113. `canConfirm={false}` means "not yet" and resolves on its own;
   * `dismissOnly` means "never", and a never must not be drawn as a button.
   */
  test('a block with no forward action offers no button to press', () => {
    const markup = renderToStaticMarkup(<ConfirmAction {...BASE} open dismissOnly />);
    expect(markup).toContain('Ends Hetzner');
    expect(markup).toContain('Cancel');
    expect(markup).not.toContain('End this payment');
  });

  test('a trigger with no possible target says why instead of just being dead', () => {
    const markup = renderToStaticMarkup(
      <ConfirmAction {...BASE} open={false} disabledReason="There is no other vendor to merge in" />
    );
    expect(markup).toContain('disabled');
    expect(markup).toContain('There is no other vendor to merge in');
  });
});
