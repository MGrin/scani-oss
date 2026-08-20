import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewPushSubscription, PushSubscription } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/** One user who could be reminded, with the zone that decides when. */
export interface ReminderCandidateRow {
  userId: string;
  timezone: string | null;
}

/**
 * Web Push endpoints — one row per browser per device (SC-226).
 *
 * The identity is the ENDPOINT, not the user: the push service issues one per
 * subscription, it is already unique, and it is what a send failure names when
 * it tells us a subscription is gone.
 */
@Service()
export class PushSubscriptionRepository extends BaseRepository<
  PushSubscription,
  NewPushSubscription
> {
  protected readonly table = schema.pushSubscriptions;
  protected readonly tableName = 'push_subscriptions';

  /**
   * Register an endpoint, or re-point an existing one.
   *
   * `onConflictDoUpdate` on the endpoint rather than `doNothing`, and the
   * conflict path rewrites `user_id` too. A shared device is the case that
   * needs it: the browser hands the same endpoint to whoever is signed in, so
   * after a second person signs in on the same phone, `doNothing` would leave
   * the row pointing at the first user and deliver their bill totals to
   * somebody else's lock screen.
   */
  async upsert(
    input: {
      userId: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      userAgent?: string | null;
    },
    transaction?: DatabaseTransaction
  ): Promise<PushSubscription> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .insert(schema.pushSubscriptions)
        .values({
          userId: input.userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? null,
        })
        .onConflictDoUpdate({
          target: schema.pushSubscriptions.endpoint,
          set: {
            userId: input.userId,
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: input.userAgent ?? null,
          },
        })
        .returning();
      if (!row) throw new Error('push subscription upsert returned no row');
      return row;
    } catch (error) {
      // The endpoint is a per-device identifier and personal data — see the
      // schema note — so it is counted, never logged.
      this.logger.error({ userId: input.userId, error }, 'Failed to upsert push subscription');
      throw error;
    }
  }

  /**
   * Remove one endpoint, scoped to its owner.
   *
   * The user scope is not decoration: the endpoint arrives from the client, so
   * without it any signed-in user could unsubscribe any device whose endpoint
   * they could guess or observe. Returns whether a row actually went, so the
   * caller can tell "unsubscribed" from "there was nothing to unsubscribe" —
   * the api reports the second as a no-op rather than as success.
   */
  async deleteByEndpoint(
    userId: string,
    endpoint: string,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const database = this.getDb(transaction);
    const removed = await database
      .delete(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.userId, userId),
          eq(schema.pushSubscriptions.endpoint, endpoint)
        )
      )
      .returning({ id: schema.pushSubscriptions.id });
    return removed.length > 0;
  }

  /**
   * Drop endpoints the push service has told us are gone (404/410).
   *
   * By id rather than by endpoint because the caller has just read these rows,
   * and because a 403 must never reach here — that is our own VAPID key
   * changing, not the user unsubscribing (see `isSubscriptionGone`).
   */
  async deleteByIds(ids: string[], transaction?: DatabaseTransaction): Promise<number> {
    if (ids.length === 0) return 0;
    const database = this.getDb(transaction);
    const removed = await database
      .delete(schema.pushSubscriptions)
      .where(inArray(schema.pushSubscriptions.id, ids))
      .returning({ id: schema.pushSubscriptions.id });
    return removed.length;
  }

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<PushSubscription[]> {
    const database = this.getDb(transaction);
    return await database
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, userId));
  }

  async markSent(ids: string[], at: Date, transaction?: DatabaseTransaction): Promise<void> {
    if (ids.length === 0) return;
    const database = this.getDb(transaction);
    await database
      .update(schema.pushSubscriptions)
      .set({ lastSentAt: at })
      .where(inArray(schema.pushSubscriptions.id, ids));
  }

  /**
   * Every user who could receive a reminder, with the timezone that decides
   * whether this hourly fire is theirs.
   *
   * The join lives on this repository because the POPULATION is a fact about
   * this table: a user with no endpoint cannot be reminded no matter what
   * their payments say, so starting anywhere else means loading users who can
   * never be sent to.
   *
   * **A null timezone is returned, not filtered out.** Filtering here would
   * make "we do not know where you are" indistinguishable from "you have no
   * subscription" one layer up, and the job could no longer report how many
   * subscribed users it is silently unable to serve — which is precisely the
   * number that tells an operator the timezone capture is broken.
   */
  async findReminderCandidates(transaction?: DatabaseTransaction): Promise<ReminderCandidateRow[]> {
    const database = this.getDb(transaction);
    return await database
      .selectDistinct({ userId: schema.users.id, timezone: schema.users.timezone })
      .from(schema.pushSubscriptions)
      .innerJoin(schema.users, eq(schema.pushSubscriptions.userId, schema.users.id));
  }

  /** How many devices are subscribed, for the Settings screen's own copy. */
  async countByUser(userId: string, transaction?: DatabaseTransaction): Promise<number> {
    const database = this.getDb(transaction);
    const [row] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, userId));
    return row?.count ?? 0;
  }
}
