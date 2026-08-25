import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { MANUAL_OUTFLOW_DESTINATIONS, movementOutflowRefusesInternal } from '@scani/shared';
import i18n from 'i18next';

/**
 * The rule in the movement sheet that is invisible in the rendered output and
 * would rot silently (SC-607).
 *
 * It is not about layout, which is why it is not asserted through markup: a
 * screenshot of this form looks identical whether an unanswered outflow is
 * submittable or not. It would ship, and it would be found later as a wrong
 * number.
 *
 * The sheet's OTHER invisible rule — what instant an unchanged date field
 * sends — moved to `DateField.test.tsx` in SC-612, along with the code. Two
 * surfaces ask for a date and they must not date the same movement
 * differently, so there is now one `dateFieldInstant` and one test of it.
 */

const t = i18n.t.bind(i18n);

describe('the outflow question', () => {
  /**
   * Both answers must reach the wire as `transfer_review` values verbatim.
   * A third spelling here would be a row this feature reads as answered and
   * the transfer-review queue reads as pending — the prompt count going back
   * to one with nothing failing.
   */
  test('the offered answers are SC-606’s vocabulary minus `internal`', () => {
    // Not a hardcoded pair: derived from the shared list the queue answers
    // with, so adding a decision there shows up here rather than silently
    // going unoffered. `internal` is excluded because it cannot move an
    // existing destination's balance — that is the `transfer` direction.
    const offered = MANUAL_OUTFLOW_DESTINATIONS.filter((d) => !movementOutflowRefusesInternal(d));
    expect([...offered]).toEqual(['left_control', 'untracked']);
    expect(MANUAL_OUTFLOW_DESTINATIONS).toContain('internal');
  });

  /** Each option says what happens to the money, in the owner's terms. */
  test('each option carries a title and a consequence', () => {
    const offered = MANUAL_OUTFLOW_DESTINATIONS.filter((d) => !movementOutflowRefusesInternal(d));
    for (const option of [...offered, 'transfer']) {
      const title = t(`v3.holdings.movement.where.${option}.title`);
      const detail = t(`v3.holdings.movement.where.${option}.detail`);
      expect(title).not.toBe(`v3.holdings.movement.where.${option}.title`);
      expect(detail).not.toBe(`v3.holdings.movement.where.${option}.detail`);
      expect(detail.length).toBeGreaterThan(20);
    }
  });
});
