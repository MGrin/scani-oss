import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { OUTFLOW_DESTINATIONS } from '@scani/shared';
import i18n from 'i18next';
import { movementInstant } from '../../../src/v3/components/holdings/RecordMovementSheet';

/**
 * The two rules in the movement sheet that are invisible in the rendered
 * output and would rot silently (SC-607).
 *
 * Neither is about layout, which is why neither is asserted through markup: a
 * screenshot of this form looks identical whether the date is sent as an
 * instant or as midnight, and identical whether an unanswered outflow is
 * submittable or not. Both would ship, and both would be found later as a
 * wrong number.
 */

const t = i18n.t.bind(i18n);

describe('the date an unchanged form sends', () => {
  /**
   * The failure this exists for is timezone-shaped and this machine may not
   * be in a timezone that shows it — so the assertion is on the RULE (today
   * is an instant, another day is midnight) rather than on a UTC string that
   * only goes red east of Greenwich.
   *
   * SC-606 measured the consequence: local midnight in UTC+12 is the previous
   * day in UTC, which lands before an observation recorded earlier the same
   * day, and a flow dated before the interval it explains leaves that interval
   * unexplained. Three prompts instead of two.
   */
  test('today is sent as the moment of recording, not as midnight', () => {
    const before = Date.now();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;

    const sent = new Date(movementInstant(today)).getTime();

    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(Date.now());
    // The must-be-ABSENT half: it is not this day's midnight.
    expect(sent).not.toBe(new Date(`${today}T00:00:00`).getTime());
  });

  test('a deliberately chosen other day is that day’s midnight', () => {
    // Local midnight, because the owner picking "the 14th" means their 14th.
    expect(movementInstant('2026-08-14')).toBe(new Date('2026-08-14T00:00:00').toISOString());
  });
});

describe('the outflow question', () => {
  /**
   * Both answers must reach the wire as `transfer_review` values verbatim.
   * A third spelling here would be a row this feature reads as answered and
   * the transfer-review queue reads as pending — the prompt count going back
   * to one with nothing failing.
   */
  test('every destination is a transfer-review decision', () => {
    expect([...OUTFLOW_DESTINATIONS]).toEqual(['left_control', 'untracked']);
  });

  /** Each option says what happens to the money, in the owner's terms. */
  test('each option carries a title and a consequence', () => {
    for (const option of [...OUTFLOW_DESTINATIONS, 'transfer']) {
      const title = t(`v3.holdings.movement.where.${option}.title`);
      const detail = t(`v3.holdings.movement.where.${option}.detail`);
      expect(title).not.toBe(`v3.holdings.movement.where.${option}.title`);
      expect(detail).not.toBe(`v3.holdings.movement.where.${option}.detail`);
      expect(detail.length).toBeGreaterThan(20);
    }
  });
});
