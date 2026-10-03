import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewUser, User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, isNotNull, isNull, lt, lte, notExists, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { Service } from 'typedi';

/** One account the weekly digest may be built for (SC-460). */
export interface DigestRecipient {
  id: string;
  email: string;
  name: string;
  baseCurrencyId: string;
  unsubscribeToken: string;
}

/** One account an alert may be mailed to (SC-459). */
export interface AlertRecipient {
  id: string;
  email: string;
  name: string;
  unsubscribeToken: string;
}

/** One account the activation nudge may be sent to (SC-1503). */
export interface NudgeRecipient {
  id: string;
  email: string;
  name: string;
  /** NULL for every account that signed up before it was recorded. */
  language: string | null;
  unsubscribeToken: string;
}

/**
 * The mail streams a reader can opt out of, and the column that records each.
 * One token authenticates all of them; this is the only thing that differs
 * between them (SC-459, SC-1503).
 */
export const EMAIL_STREAMS = {
  digest: 'digest',
  alerts: 'alerts',
  onboarding: 'onboarding',
} as const;

export type EmailStream = (typeof EMAIL_STREAMS)[keyof typeof EMAIL_STREAMS];

const OPT_OUT_COLUMN = {
  [EMAIL_STREAMS.digest]: 'digestOptOutAt',
  [EMAIL_STREAMS.alerts]: 'alertsOptOutAt',
  [EMAIL_STREAMS.onboarding]: 'onboardingOptOutAt',
} as const satisfies Record<EmailStream, keyof typeof schema.users.$inferSelect>;

@Service()
export class UserRepository extends BaseRepository<User, NewUser> {
  protected readonly table = schema.users;
  protected readonly tableName = 'users';

  /**
   * Accounts that may be MAILED a weekly digest. Whether one is actually
   * WORTH mailing is a question about their portfolio, and `WeeklyDigestService`
   * answers it — this method only applies the four conditions that are about
   * permission and plumbing:
   *
   * - `email_verified` — an unverified address is one nobody has proven they
   *   own, and unsolicited mail to it is the spam report this feature exists
   *   to avoid.
   * - `digest_opt_out_at IS NULL` — the one-click unsubscribe, honoured here.
   * - `base_currency_id IS NOT NULL` — the digest's headline is a figure in the
   *   user's base currency. Without one there is no figure to state.
   * - `digest_last_sent_at` older than `cooldownBefore` — the retry guard. See
   *   the migration comment; the advisory lock does not cover a retried run.
   */
  async findDigestRecipients(
    cooldownBefore: Date,
    transaction?: DatabaseTransaction
  ): Promise<DigestRecipient[]> {
    const rows = await this.getDb(transaction)
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        baseCurrencyId: schema.users.baseCurrencyId,
        unsubscribeToken: schema.users.emailUnsubscribeToken,
      })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.emailVerified, true),
          isNull(schema.users.digestOptOutAt),
          isNotNull(schema.users.baseCurrencyId),
          or(
            isNull(schema.users.digestLastSentAt),
            lt(schema.users.digestLastSentAt, cooldownBefore)
          )
        )
      );
    // `isNotNull` above is the runtime check; the cast is the type system
    // catching up with it.
    return rows as DigestRecipient[];
  }

  async markDigestSent(
    userId: string,
    at: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<void> {
    await this.getDb(transaction)
      .update(schema.users)
      .set({ digestLastSentAt: at })
      .where(eq(schema.users.id, userId));
  }

  /**
   * Accounts that may be MAILED an alert (SC-459). Whether any of them has
   * anything to be alerted ABOUT is the rule's question, not this one's.
   *
   * Two conditions, both about permission, and deliberately one fewer than
   * `findDigestRecipients`: an alert quotes no figure, so it needs no base
   * currency. The digest's do-not-mail-an-empty-account guardrail is carried
   * here by the rule instead — a stale-integration alert can only exist for an
   * account that connected an integration, which is more engagement than the
   * digest's threshold asks for.
   */
  async findAlertRecipients(
    userIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<AlertRecipient[]> {
    if (userIds.length === 0) return [];
    return this.getDb(transaction)
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        unsubscribeToken: schema.users.emailUnsubscribeToken,
      })
      .from(schema.users)
      .where(
        and(
          inArray(schema.users.id, userIds),
          eq(schema.users.emailVerified, true),
          isNull(schema.users.alertsOptOutAt)
        )
      );
  }

  /**
   * Honour an unsubscribe link for one stream. Returns true when the token
   * named a real account — including one that had already opted out, because a
   * second click on the same link is a user asking for the same outcome they
   * already have, and telling them it failed would send them looking for
   * another way.
   *
   * `IS NULL` in the WHERE so the FIRST opt-out keeps its date, for the same
   * reason `markFirstExport` does.
   *
   * One method for both streams, because the token is the same credential and
   * only the column recording the choice differs (SC-459). Two near-identical
   * methods is how one of them ends up with the `IS NULL` guard and the other
   * without it.
   */
  async optOutByToken(
    stream: EmailStream,
    token: string,
    at: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const key = OPT_OUT_COLUMN[stream];
    const column: PgColumn = schema.users[key];
    const db = this.getDb(transaction);
    await db
      .update(schema.users)
      .set({ [key]: at })
      .where(and(eq(schema.users.emailUnsubscribeToken, token), isNull(column)));
    const found = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.emailUnsubscribeToken, token))
      .limit(1);
    return found.length > 0;
  }

  /**
   * Accounts the activation nudge may be sent to (SC-1503): verified, signed
   * up on or before `signedUpBefore`, never nudged, not opted out, and with
   * nothing added — no account and no holding.
   */
  async findActivationNudgeRecipients(
    signedUpBefore: Date,
    transaction?: DatabaseTransaction
  ): Promise<NudgeRecipient[]> {
    const db = this.getDb(transaction);
    return db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        language: schema.users.language,
        unsubscribeToken: schema.users.emailUnsubscribeToken,
      })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.emailVerified, true),
          lte(schema.users.createdAt, signedUpBefore),
          isNull(schema.users.activationNudgeSentAt),
          isNull(schema.users.onboardingOptOutAt),
          notExists(
            db
              .select({ id: schema.accounts.id })
              .from(schema.accounts)
              .where(eq(schema.accounts.userId, schema.users.id))
          ),
          notExists(
            db
              .select({ id: schema.holdings.id })
              .from(schema.holdings)
              .where(eq(schema.holdings.userId, schema.users.id))
          )
        )
      );
  }

  /**
   * Take the one nudge this account will ever get. True only for the caller
   * that set the column: `IS NULL` in the WHERE makes a second run, or a
   * BullMQ retry, match nothing.
   */
  async claimActivationNudge(
    userId: string,
    at: Date,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const claimed = await this.getDb(transaction)
      .update(schema.users)
      .set({ activationNudgeSentAt: at })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.activationNudgeSentAt)))
      .returning({ id: schema.users.id });
    return claimed.length > 0;
  }

  /**
   * Give a claim back after the send failed, so tomorrow's run tries again.
   * Only the claim this caller made: a later one is somebody else's.
   */
  async releaseActivationNudge(
    userId: string,
    at: Date,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    await this.getDb(transaction)
      .update(schema.users)
      .set({ activationNudgeSentAt: null })
      .where(and(eq(schema.users.id, userId), eq(schema.users.activationNudgeSentAt, at)));
  }

  /**
   * Record that this account got a file out of the product for the first time
   * (SC-450, funnel step 6).
   *
   * `IS NULL` in the WHERE rather than a read-then-write: two exports racing
   * would both see NULL and the later one would overwrite the earlier date,
   * which is the one thing this column must not do. Postgres settles it in a
   * single statement, so the second UPDATE matches nothing.
   */
  async markFirstExport(
    userId: string,
    at: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<void> {
    await this.getDb(transaction)
      .update(schema.users)
      .set({ firstExportAt: at })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.firstExportAt)));
  }
}
