import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, gte, lt, notExists } from 'drizzle-orm';
import { Service } from 'typedi';

const IDLE_AFTER_MS = 7 * 24 * 3_600_000;
export const IDLE_SYNC_EVERY_HOURS = 6;

/**
 * Which users the hourly balance syncs leave out of this run (SC-1602). A
 * user older than seven days with no session refreshed in seven days is
 * synced every sixth hour only; a newer account is never idle. Opening the
 * app syncs them at once, so the slower cadence costs a returning user
 * nothing.
 *
 * `user_sessions.updated_at` moves at most once a day (`updateAge: 1d`),
 * which is precise enough at seven days. The hour decides rather than a
 * per-user clock, so idle users' syncs land in the same burst as everyone
 * else's and the database can still sleep between runs.
 */
@Service()
export class IdleUserSyncPolicy {
  async usersToSkip(now: Date = new Date()): Promise<Set<string>> {
    if (now.getUTCHours() % IDLE_SYNC_EVERY_HOURS === 0) return new Set();
    return this.idleUserIds(now);
  }

  /** Every idle user, whatever the hour: the stale-sync probe's cadence (SC-1629). */
  async idleUserIds(now: Date = new Date()): Promise<Set<string>> {
    const since = new Date(now.getTime() - IDLE_AFTER_MS);
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          lt(schema.users.createdAt, since),
          notExists(
            db
              .select({ one: schema.userSessions.id })
              .from(schema.userSessions)
              .where(
                and(
                  eq(schema.userSessions.userId, schema.users.id),
                  gte(schema.userSessions.updatedAt, since)
                )
              )
          )
        )
      );
    return new Set(rows.map((row) => row.id));
  }
}
