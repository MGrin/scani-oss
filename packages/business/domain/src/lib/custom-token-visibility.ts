import { type SQL, sql } from 'drizzle-orm';

/**
 * A custom token is private to the user who created it (SC-1285, mgrin
 * 2026-09-21). Custom means these two types and nothing else — the same
 * definition `TokenService` and `TokenPriceHistoryService` use.
 */
export const CUSTOM_TOKEN_TYPE_CODES = ['private-company', 'other'] as const;

export type CustomTokenTypeCode = (typeof CUSTOM_TOKEN_TYPE_CODES)[number];

export function isCustomTokenTypeCode(code: string | null | undefined): boolean {
  return (CUSTOM_TOKEN_TYPE_CODES as readonly string[]).includes(code ?? '');
}

/**
 * Whether `userId` may see, price or hold this token. A catalog token is
 * everybody's; a custom one is its owner's alone, and a custom token with no
 * owner is NOBODY's — the backfill leaves one unattributed only when no record
 * says who made it, and "unknown" must not read as "everyone".
 */
export function isTokenVisibleTo(
  token: { createdByUserId: string | null },
  typeCode: string | null | undefined,
  userId: string
): boolean {
  return !isCustomTokenTypeCode(typeCode) || token.createdByUserId === userId;
}

/**
 * The SQL form of `isTokenVisibleTo`, for a query over `tokens`. It asks the
 * type through a subquery so a caller need not join `token_types` to use it.
 *
 * The tokens relation is spelled as a qualified identifier rather than a
 * drizzle column, for the reason `effectiveScamProbability` gives: a column
 * interpolated into raw `sql` can render unqualified and bind to the wrong
 * relation inside the subquery, silently.
 */
export function customTokenVisibleTo(userId: string, tokens = 'tokens'): SQL {
  const t = sql.identifier(tokens);
  return sql`(${t}.created_by_user_id = ${userId} OR ${catalogTokenOnly(tokens)})`;
}

/**
 * The token is not a custom one — for a lookup that serves every user at once
 * and so has no owner to scope to, such as resolving a currency by symbol.
 * Without it the newest row wins, and a user who created a custom `USD` would
 * have become everybody's USD (SC-1285).
 */
export function catalogTokenOnly(tokens = 'tokens'): SQL {
  const t = sql.identifier(tokens);
  return sql`${t}.type_id NOT IN (
    SELECT tt.id FROM token_types tt
    WHERE tt.code IN (${sql.join(
      CUSTOM_TOKEN_TYPE_CODES.map((code) => sql`${code}`),
      sql`, `
    )})
  )`;
}
