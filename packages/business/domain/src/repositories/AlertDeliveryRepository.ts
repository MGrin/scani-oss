import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { AlertDelivery, NewAlertDelivery } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/** One alert a rule wants to send, before it is known whether it may. */
export interface AlertCandidate {
  userId: string;
  /** Opaque to everything but the rule that minted it. */
  dedupeKey: string;
}

/** A candidate this process now owns and is responsible for delivering. */
export interface ClaimedAlert extends AlertCandidate {
  id: string;
}

/**
 * A claim written but never delivered is assumed abandoned after this long and
 * may be retaken.
 *
 * The window has to sit above every retry chain — a claim retaken while the
 * first attempt is still in flight is the duplicate this whole class exists to
 * prevent — and below the gap between two fires of the sweep, or a crash costs
 * the user a real alert until tomorrow. An hour is comfortably both.
 */
export const ALERT_CLAIM_TTL_MS = 60 * 60 * 1000;

/**
 * The ledger that makes "never send the same alert twice" true (SC-459).
 *
 * Neither guard already in the codebase covers it. The scheduled job's advisory
 * lock stops two OVERLAPPING fires and says nothing about a BullMQ retry of a
 * run that already mailed half its recipients. `users.digest_last_sent_at` is a
 * per-account cooldown — right for one weekly letter, useless for "tell me
 * about this integration but not about this integration again".
 *
 * The protocol is three calls, in this order:
 *
 *   1. `claim` — take ownership of the candidates nobody has been told about.
 *   2. send, then `markSent` — or `release` if the send failed.
 *   3. `resolve` — delete the rows whose condition has cleared, which is what
 *      lets the same fault alert a second time if it happens a second time.
 *
 * Claiming BEFORE sending is the load-bearing choice, and it is not the
 * obvious one: recording after a successful send loses nothing to a transport
 * error but duplicates every alert in a run that dies between the send and the
 * write. This orders the failure the other way — a crash suppresses rather than
 * repeats — and `ALERT_CLAIM_TTL_MS` bounds how long that suppression lasts.
 */
@Service()
export class AlertDeliveryRepository extends BaseRepository<AlertDelivery, NewAlertDelivery> {
  protected readonly table = schema.alertDeliveries;
  protected readonly tableName = 'alert_deliveries';

  /**
   * Take ownership of every candidate that is neither already delivered nor
   * already claimed by a live attempt. Returns only the rows this call now
   * owns; anything absent from the result has been handled elsewhere and must
   * NOT be sent.
   *
   * One statement, because the check and the take have to be atomic: two
   * processes evaluating "is there a row?" separately from "insert one" is
   * exactly the race the unique index exists to settle. `ON CONFLICT … DO
   * UPDATE … WHERE` is what makes the index return the row to the winner and
   * nothing to the loser — a plain `DO NOTHING` returns nothing to BOTH, which
   * would silently drop the first alert an account ever gets.
   */
  async claim(
    rule: string,
    candidates: AlertCandidate[],
    now: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<ClaimedAlert[]> {
    if (candidates.length === 0) return [];
    const abandonedBefore = new Date(now.getTime() - ALERT_CLAIM_TTL_MS);
    const values = sql.join(
      candidates.map(
        (c) => sql`(${c.userId}::uuid, ${rule}, ${c.dedupeKey}, ${now.toISOString()}::timestamptz)`
      ),
      sql`, `
    );
    const rows = (await this.getDb(transaction).execute(sql`
      insert into alert_deliveries (user_id, rule, dedupe_key, created_at)
      values ${values}
      on conflict (user_id, rule, dedupe_key) do update
        set created_at = excluded.created_at
        where alert_deliveries.sent_at is null
          and alert_deliveries.created_at < ${abandonedBefore.toISOString()}::timestamptz
      returning id, user_id, dedupe_key
    `)) as unknown as Array<{ id: string; user_id: string; dedupe_key: string }>;
    return rows.map((r) => ({ id: r.id, userId: r.user_id, dedupeKey: r.dedupe_key }));
  }

  /** The alert reached the transport. From here the row suppresses forever. */
  async markSent(
    ids: string[],
    at: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.getDb(transaction)
      .update(schema.alertDeliveries)
      .set({ sentAt: at })
      .where(inArray(schema.alertDeliveries.id, ids));
  }

  /**
   * Give a claim back after a failed send, so the next sweep retries rather
   * than waiting out `ALERT_CLAIM_TTL_MS`.
   *
   * `sent_at is null` in the WHERE even though this only ever runs on rows that
   * were just claimed: if a release somehow races a `markSent`, deleting a
   * delivered row would re-alert somebody about something they have already
   * been told, which is the one outcome this file may not produce.
   */
  async release(ids: string[], transaction?: DatabaseTransaction): Promise<void> {
    if (ids.length === 0) return;
    await this.getDb(transaction)
      .delete(schema.alertDeliveries)
      .where(
        and(inArray(schema.alertDeliveries.id, ids), sql`${schema.alertDeliveries.sentAt} is null`)
      );
  }

  /**
   * Forget every alert of this rule whose condition no longer holds, and return
   * how many. `activeKeys` is the CURRENT truth for the whole rule across every
   * account — an empty array means nothing is wrong anywhere and clears the
   * rule outright, which is a legitimate state and not a guard to bail out of.
   *
   * This is the half that makes the ledger a set of OPEN alerts rather than an
   * ever-growing log. Without it an integration that broke, was fixed, and
   * broke again would never say so twice.
   */
  async resolve(
    rule: string,
    activeKeys: Array<{ userId: string; dedupeKey: string }>,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    const db = this.getDb(transaction);
    if (activeKeys.length === 0) {
      const cleared = await db
        .delete(schema.alertDeliveries)
        .where(eq(schema.alertDeliveries.rule, rule))
        .returning({ id: schema.alertDeliveries.id });
      return cleared.length;
    }
    const keep = sql.join(
      activeKeys.map((k) => sql`(${k.userId}::uuid, ${k.dedupeKey})`),
      sql`, `
    );
    const cleared = (await db.execute(sql`
      delete from alert_deliveries
      where rule = ${rule}
        and (user_id, dedupe_key) not in (${keep})
      returning id
    `)) as unknown as Array<{ id: string }>;
    return cleared.length;
  }
}
