import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { MANUAL_EDIT_CAUSES } from '@scani/shared';
import { dateFieldInstant, todayIso } from '../../../src/v3/components/form/DateField';
import { holdingEditOccurredAt } from '../../../src/v3/components/holdings/HoldingEditCauseDialog';

/**
 * What the cause dialog sends as the date — the one thing about this form
 * neither a type check nor a rendered snapshot can see.
 *
 * The dialog is a Radix dialog and Radix renders nothing under
 * `renderToStaticMarkup`, so there is no markup to drive; and the form looks
 * identical whether it sends the edit instant or the start of the day. That
 * combination is exactly how SC-612 shipped: a wrong number in a ledger, a day
 * late, with nothing red anywhere.
 */
describe('the date a cause answer carries', () => {
  test('a flow left on today is dated NOW, not at the start of the day', () => {
    const before = Date.now();
    const sent = holdingEditOccurredAt('flow', todayIso());

    expect(sent).toBeDefined();
    const at = new Date(sent as string).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  test('a flow the owner dated to another day keeps that day', () => {
    // Routed through the shared rule rather than restating it, so the two
    // surfaces that ask for a date cannot answer differently (SC-612).
    expect(holdingEditOccurredAt('flow', '2026-08-14')).toBe(dateFieldInstant('2026-08-14'));
  });

  test('nothing but a flow carries a date at all', () => {
    // The must-be-ABSENT control, and it enumerates the causes rather than
    // naming two: a fourth would otherwise reach the server with a date the
    // user never gave, and be stamped as though they had.
    const dated = MANUAL_EDIT_CAUSES.filter(
      (cause) => holdingEditOccurredAt(cause, todayIso()) !== undefined
    );
    expect(dated).toEqual(['flow']);
  });
});
