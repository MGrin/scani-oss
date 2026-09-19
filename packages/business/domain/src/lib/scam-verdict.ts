import { type SQL, sql } from 'drizzle-orm';
import { SCAM_PROBABILITY_THRESHOLD } from './constants';

/**
 * The scam score a USER sees for a token: their own verdict where they gave
 * one, the shared `tokens.is_scam_probability` otherwise (SC-1160).
 *
 * A verdict is per user by mgrin's ruling of 2026-09-14 — marking a token as a
 * scam must not change it for anybody else — so it cannot live on `tokens`,
 * and every read that decides "is this holding a scam" has to resolve it. They
 * all go through here rather than each spelling the lookup, because the one
 * that forgot would disagree with the others by a whole token's value, the
 * failure `holding-inclusion.ts` exists to stop between the headline and the
 * chart.
 *
 * `scam` reads as 1 and `not_scam` as 0 — the two ends of the scale the shared
 * score lives on — so every consumer keeps comparing against
 * `SCAM_PROBABILITY_THRESHOLD` and none of them learns a new type.
 *
 * **The outer references are spelled as qualified identifiers, not drizzle
 * columns, and that is load-bearing.** Drizzle renders a column interpolated
 * into a SELECT-list `sql` template UNQUALIFIED, and inside this correlated
 * subquery `"user_id"` and `"id"` then bind to the verdict table's own columns
 * — valid SQL, no error, the wrong answer (`GroupRepository.holdingsCount`
 * met the same thing). The two aliases name the holdings and tokens relations
 * of the enclosing query.
 */
export function effectiveScamProbability(holdings = 'holdings', tokens = 'tokens'): SQL<number> {
  const h = sql.identifier(holdings);
  const t = sql.identifier(tokens);
  return sql<number>`COALESCE((
    SELECT CASE v.verdict WHEN 'scam' THEN 1 ELSE 0 END
    FROM user_token_scam_verdicts v
    WHERE v.user_id = ${h}.user_id AND v.token_id = ${t}.id
  ), ${t}.is_scam_probability)`.mapWith(Number);
}

/** The holding's token is NOT a scam for its owner — the filter form. */
export function notScamFor(holdings = 'holdings', tokens = 'tokens'): SQL {
  return sql`${effectiveScamProbability(holdings, tokens)} < ${SCAM_PROBABILITY_THRESHOLD}`;
}
