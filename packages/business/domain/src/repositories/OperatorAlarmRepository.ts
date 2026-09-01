import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewOperatorAlarm, OperatorAlarm } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { sql } from 'drizzle-orm';
import { Service } from 'typedi';

export interface AlarmSyncOptions {
  now: Date;
  /**
   * How long a condition may stay open without being re-stated.
   *
   * Not a retry and not a rate limit: it is the answer to "and what if it is
   * still broken in a month?". Suppressing the repeat and then never speaking
   * again is the opposite failure to the one being fixed, and it is the quieter
   * of the two.
   */
  renotifyAfterMs: number;
}

export interface AlarmSyncResult {
  /** Newly true. This is the news, and the only thing the old alarm got right. */
  entered: string[];
  /**
   * Open since before this run and stated again because the re-notify window
   * elapsed. Kept apart from `entered` because they are different news: one is
   * "this just broke", the other "this is still broken", and a reader who
   * cannot tell them apart investigates a week-old condition as if it were new.
   */
  restated: string[];
  /** These were open and the condition no longer holds. The alarm is re-armed. */
  cleared: string[];
  /** Still true, already stated. Silence here is suppression, not recovery. */
  suppressed: string[];
}

/**
 * The ledger that makes an operator alarm fire on ENTERING a condition rather
 * than on every probe that observes it (SC-870).
 *
 * `stale-sync-probe` runs hourly and, until this existed, called
 * `captureException` on every run for as long as any integration was broken —
 * so one unresolved condition could account for the great majority of a
 * service's error volume. The defect is not the volume. A repeating alarm
 * makes low-frequency signals unreadable: a job that fails once a day is
 * outnumbered by something already known, and stays unread for as long as the
 * loud condition lasts. A persistent condition manufactures a hiding place,
 * and resolving one instance of it does not stop the next one rebuilding
 * another.
 *
 * The user-facing half of this exact signal already worked this way —
 * `AlertDeliveryRepository`, SC-459 — so the shape here is borrowed rather than
 * invented. What SC-870 fixes is that only the half addressed to the USER ever
 * got it, and the half addressed to US is the one nobody could opt out of.
 *
 * **Not a rate limit and not Sentry-side grouping**, both of which were
 * considered and rejected on the ticket: each suppresses the repeat and also
 * suppresses a genuine re-entry after recovery, which is the event most worth
 * having. Absence-of-a-row is what makes re-entry legible.
 */
@Service()
export class OperatorAlarmRepository extends BaseRepository<OperatorAlarm, NewOperatorAlarm> {
  protected readonly table = schema.operatorAlarms;
  protected readonly tableName = 'operator_alarms';

  /**
   * Reconcile the alarm against the conditions that are true RIGHT NOW, and
   * return what the caller must escalate.
   *
   * `keys` is the complete current truth for this alarm — an empty array means
   * nothing is wrong and clears it outright, which is a legitimate state and
   * not a guard to bail out of. Anything open and absent from `keys` has
   * recovered.
   *
   * Two statements, no wrapping transaction, and the order is load-bearing.
   * Clearing first means a crash between them leaves nothing opened, so the
   * next probe opens and fires; opening first would risk a row that is both
   * escalated and stale. Neither statement is destructive on a retry — this
   * job holds an advisory lock, so the only interleaving to survive is a crash,
   * not a peer.
   */
  async sync(
    alarm: string,
    keys: string[],
    options: AlarmSyncOptions,
    transaction?: DatabaseTransaction
  ): Promise<AlarmSyncResult> {
    const db = this.getDb(transaction);
    const now = options.now;
    const renotifyBefore = new Date(now.getTime() - options.renotifyAfterMs);

    // `<> all(...)` over an explicitly typed array rather than a branch:
    // `array[]::text[]` is legal and matches every open row, so "nothing is
    // broken any more" clears the alarm. An early return on an empty `keys` is
    // precisely how that stops happening.
    const activeKeys = sql`array[${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `
    )}]::text[]`;
    const clearedRows = (await db.execute(sql`
      delete from operator_alarms
       where alarm = ${alarm}
         and alarm_key <> all(${activeKeys})
      returning alarm_key
    `)) as unknown as Array<{ alarm_key: string }>;
    const cleared = clearedRows.map((r) => r.alarm_key);

    if (keys.length === 0) return { entered: [], restated: [], cleared, suppressed: [] };

    // One statement, because the check and the take have to be atomic. The
    // `WHERE` on the conflict branch is the whole fix: a key already open and
    // recently stated updates nothing and RETURNS nothing, so the caller is
    // silent about it. `opened_at` is never in the SET — it records how long
    // this has been true and a re-statement must not reset it.
    const values = sql.join(
      keys.map(
        (key) =>
          sql`(${alarm}, ${key}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`
      ),
      sql`, `
    );
    // `opened_at = now` is how a fresh row is told from a re-stated one, and it
    // needs no Postgres internals to read: this statement is the only writer of
    // `opened_at`, and the conflict branch never touches it. So the value coming
    // back equals this run's timestamp exactly when this run created the row.
    const firedRows = (await db.execute(sql`
      insert into operator_alarms (alarm, alarm_key, opened_at, last_fired_at)
      values ${values}
      on conflict (alarm, alarm_key) do update
        set last_fired_at = excluded.last_fired_at
        where operator_alarms.last_fired_at <= ${renotifyBefore.toISOString()}::timestamptz
      returning alarm_key, (opened_at = ${now.toISOString()}::timestamptz) as is_new
    `)) as unknown as Array<{ alarm_key: string; is_new: boolean }>;

    const entered = firedRows.filter((r) => r.is_new).map((r) => r.alarm_key);
    const restated = firedRows.filter((r) => !r.is_new).map((r) => r.alarm_key);

    const fired = new Set(firedRows.map((r) => r.alarm_key));
    return { entered, restated, cleared, suppressed: keys.filter((k) => !fired.has(k)) };
  }
}
