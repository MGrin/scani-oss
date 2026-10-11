import { describe, expect, test } from 'bun:test';
import { HEARTBEAT_DAILY_DEADLINE_UTC_HOUR, missedDailyDeadline } from '../../src/scheduled-jobs';

const at = (iso: string) => new Date(iso);

// db-backup is the nightly group's last step (SC-1688), so it completes
// whenever the chain does. The deadline is what still says when that is late.
describe('missedDailyDeadline', () => {
  test('db-backup must complete by 07:00 UTC', () => {
    expect(HEARTBEAT_DAILY_DEADLINE_UTC_HOUR['db-backup']).toBe(7);
  });

  test('before the deadline nothing is overdue, even with no backup yet today', () => {
    expect(missedDailyDeadline(at('2026-10-09T00:40:00Z'), at('2026-10-10T06:59:00Z'), 7)).toBe(
      false
    );
  });

  test('after the deadline, a backup completed today is not overdue', () => {
    expect(missedDailyDeadline(at('2026-10-10T00:41:00Z'), at('2026-10-10T07:00:00Z'), 7)).toBe(
      false
    );
  });

  test('after the deadline, a last backup from yesterday is overdue', () => {
    expect(missedDailyDeadline(at('2026-10-09T00:40:00Z'), at('2026-10-10T07:00:00Z'), 7)).toBe(
      true
    );
  });

  test('a backup that completed after the deadline clears it', () => {
    expect(missedDailyDeadline(at('2026-10-10T08:10:00Z'), at('2026-10-10T08:15:00Z'), 7)).toBe(
      false
    );
  });
});
