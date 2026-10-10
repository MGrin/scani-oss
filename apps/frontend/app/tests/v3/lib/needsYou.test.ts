import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { needsYouRows } from '../../../src/v3/lib/needs-you';

/** SC-1669: the strip under the hero lists only what asks the person to act. */

const TODAY = '2026-10-09';
const bill = (id: string, dueDate: string) => ({ id, dueDate });

describe('needsYouRows', () => {
  test('review first, then overdue, then due within three days', () => {
    const rows = needsYouRows({
      reviewCount: 2,
      bills: [bill('a', '2026-10-01'), bill('b', '2026-10-11'), bill('c', '2026-10-30')],
      today: TODAY,
    });
    expect(rows).toEqual([
      { kind: 'review', count: 2 },
      { kind: 'overdue', count: 1, onlyId: 'a' },
      { kind: 'dueSoon', count: 1, onlyId: 'b' },
    ]);
  });

  test('two bills in a row link to the list rather than one of them', () => {
    const rows = needsYouRows({
      reviewCount: 0,
      bills: [bill('a', '2026-10-09'), bill('b', '2026-10-12')],
      today: TODAY,
    });
    expect(rows).toEqual([{ kind: 'dueSoon', count: 2, onlyId: null }]);
  });

  test('a bill four days out does not need you yet', () => {
    // The control for the arm above: without it, a window that took every
    // bill would pass both tests.
    expect(
      needsYouRows({ reviewCount: 0, bills: [bill('a', '2026-10-13')], today: TODAY })
    ).toEqual([]);
  });

  test('a source that did not answer adds no row rather than a zero', () => {
    expect(needsYouRows({ reviewCount: null, bills: null, today: TODAY })).toEqual([]);
  });
});
