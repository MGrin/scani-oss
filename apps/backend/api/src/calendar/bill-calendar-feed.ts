import { createHash, randomBytes } from 'node:crypto';
import { db } from '@scani/db/connection';
import { billCalendarFeeds } from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Service } from 'typedi';

export const BILL_CALENDAR_TOKEN_PREFIX = 'scani_cal_';

/** 256 bits: the URL is the only thing between a stranger and the user's bills. */
const TOKEN_BYTES = 32;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function mintToken(): string {
  return `${BILL_CALENDAR_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export interface BillCalendarFeedStatus {
  enabled: boolean;
  createdAt: Date | null;
}

/**
 * A user's opt-in bills calendar feed (SC-1654). The raw token is returned
 * once, by `enable` or `rotate`, and never stored.
 */
@Service()
export class BillCalendarFeedService {
  async status(userId: string): Promise<BillCalendarFeedStatus> {
    const [row] = await db
      .select({ createdAt: billCalendarFeeds.createdAt })
      .from(billCalendarFeeds)
      .where(eq(billCalendarFeeds.userId, userId))
      .limit(1);
    return row ? { enabled: true, createdAt: row.createdAt } : { enabled: false, createdAt: null };
  }

  /** Turns the feed on, replacing any previous URL. */
  async enable(userId: string): Promise<string> {
    const token = mintToken();
    const hashedToken = hashToken(token);
    await db
      .insert(billCalendarFeeds)
      .values({ userId, hashedToken })
      .onConflictDoUpdate({
        target: billCalendarFeeds.userId,
        set: { hashedToken, createdAt: new Date() },
      });
    return token;
  }

  /** A new URL for a feed that is on; null when it is off, which it stays. */
  async rotate(userId: string): Promise<string | null> {
    const token = mintToken();
    const rows = await db
      .update(billCalendarFeeds)
      .set({ hashedToken: hashToken(token), createdAt: new Date() })
      .where(eq(billCalendarFeeds.userId, userId))
      .returning({ userId: billCalendarFeeds.userId });
    return rows.length === 1 ? token : null;
  }

  async disable(userId: string): Promise<void> {
    await db.delete(billCalendarFeeds).where(eq(billCalendarFeeds.userId, userId));
  }

  /**
   * The owner of a presented token, or null. Every input takes the same path,
   * one hash and one lookup by the hash's unique index, with no early return
   * for a malformed token: how fast a 404 comes back says nothing about what
   * was sent.
   */
  async resolve(raw: string): Promise<string | null> {
    const [row] = await db
      .select({ userId: billCalendarFeeds.userId })
      .from(billCalendarFeeds)
      .where(eq(billCalendarFeeds.hashedToken, hashToken(raw)))
      .limit(1);
    return row?.userId ?? null;
  }
}
