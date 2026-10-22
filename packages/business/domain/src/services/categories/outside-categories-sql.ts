import { KINDS_OUTSIDE_CATEGORIES } from '@scani/shared';
import { type SQL, sql } from 'drizzle-orm';

/**
 * `h` takes a category: not a trade, swap, settlement, transfer, opening
 * balance or restatement, and not a linked transfer leg (SC-1720). A linked
 * leg moves money between a person's own accounts, and tagging both legs
 * would count it twice (SC-1695).
 */
export const TAKES_A_CATEGORY: SQL = sql`h.transfer_group_id is null
  and h.kind not in (${sql.join(
    KINDS_OUTSIDE_CATEGORIES.map((kind) => sql`${kind}`),
    sql`, `
  )})`;
