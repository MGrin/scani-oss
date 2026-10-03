import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { inArray } from 'drizzle-orm';

export interface CommittedRows {
  users: string[];
  tokens: string[];
  institutions: string[];
  /** Deletes every row pushed so far, and forgets them. */
  drop: () => Promise<void>;
}

/**
 * The rows a test commits outside `withTestDb`'s rollback, because history and
 * labels read committed rows only. Push each id as it is made, and
 * `afterEach(rows.drop)`.
 */
export function committedRows(): CommittedRows {
  const users: string[] = [];
  const tokens: string[] = [];
  const institutions: string[] = [];
  return {
    users,
    tokens,
    institutions,
    drop: async () => {
      const db = getDb();
      const userIds = users.splice(0);
      const tokenIds = tokens.splice(0);
      const institutionIds = institutions.splice(0);
      // Users first: their holdings are what keep the tokens restricted.
      if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
      if (tokenIds.length)
        await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds));
      if (institutionIds.length) {
        await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
      }
    },
  };
}
