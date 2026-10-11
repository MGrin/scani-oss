import { createHash, randomBytes } from 'node:crypto';
import { db } from '@scani/db/connection';
import { personalAccessTokens } from '@scani/db/schema';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { Service } from 'typedi';

export const PERSONAL_ACCESS_TOKEN_PREFIX = 'scani_pat_';
export const MAX_LIVE_TOKENS_PER_USER = 10;
export const AGENT_READ_SCOPE = 'portfolio:read';
/** Lists and runs the write tools; every write is logged and undoable (SC-1617). */
export const AGENT_WRITE_SCOPE = 'portfolio:write';

// Enough after the prefix to tell two tokens apart in a list; far short of
// guessable.
const DISPLAY_HEX_CHARS = 6;

export class PersonalAccessTokenLimitError extends Error {
  constructor() {
    super(`At most ${MAX_LIVE_TOKENS_PER_USER} live tokens per account — revoke one first`);
  }
}

export interface VerifiedPersonalToken {
  tokenId: string;
  userId: string;
  scopes: string[];
}

export interface PersonalAccessTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  createdAt: Date;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * A user's own bearer tokens for their AI agent (SC-1614). The raw token is
 * returned once by `create` and never stored; a lookup hashes what is
 * presented. The shape follows the Cloud keys in the data-provider.
 */
@Service()
export class PersonalAccessTokenService {
  async create(
    userId: string,
    name: string,
    opts: { allowWrites?: boolean } = {}
  ): Promise<PersonalAccessTokenSummary & { token: string }> {
    const [live] = await db
      .select({ n: count() })
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)));
    if ((live?.n ?? 0) >= MAX_LIVE_TOKENS_PER_USER) throw new PersonalAccessTokenLimitError();

    const token = `${PERSONAL_ACCESS_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    const [row] = await db
      .insert(personalAccessTokens)
      .values({
        userId,
        name,
        tokenPrefix: token.slice(0, PERSONAL_ACCESS_TOKEN_PREFIX.length + DISPLAY_HEX_CHARS),
        hashedToken: hashToken(token),
        scopes: opts.allowWrites ? [AGENT_READ_SCOPE, AGENT_WRITE_SCOPE] : [AGENT_READ_SCOPE],
      })
      .returning();
    if (!row) throw new Error('personal_access_tokens insert returned no row');
    return { ...toSummary(row), token };
  }

  async list(userId: string): Promise<PersonalAccessTokenSummary[]> {
    const rows = await db
      .select()
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
      .orderBy(desc(personalAccessTokens.createdAt));
    return rows.map(toSummary);
  }

  /** False when the token is not the caller's, or is already revoked. */
  async revoke(userId: string, tokenId: string): Promise<boolean> {
    const rows = await db
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(personalAccessTokens.id, tokenId),
          eq(personalAccessTokens.userId, userId),
          isNull(personalAccessTokens.revokedAt)
        )
      )
      .returning({ id: personalAccessTokens.id });
    return rows.length === 1;
  }

  async verify(raw: string): Promise<VerifiedPersonalToken | null> {
    if (!raw.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)) return null;
    const [row] = await db
      .select()
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.hashedToken, hashToken(raw)),
          isNull(personalAccessTokens.revokedAt)
        )
      )
      .limit(1);
    if (!row) return null;
    await db
      .update(personalAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(personalAccessTokens.id, row.id));
    return { tokenId: row.id, userId: row.userId, scopes: row.scopes };
  }
}

function toSummary(row: typeof personalAccessTokens.$inferSelect): PersonalAccessTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}
