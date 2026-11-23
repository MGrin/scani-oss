import { sql } from 'drizzle-orm';
import { TAKES_A_CATEGORY } from './outside-categories-sql';

export const CUSTOM_RULE_ELIGIBLE = sql`${TAKES_A_CATEGORY}
  and h.user_id = holding.user_id and holding.user_id = account.user_id
  and h.token_id = holding.token_id and token_type.code = 'fiat'
  and ((h.kind = 'withdraw' and h.ledger_kind = 'outflow') or (h.kind = 'fee' and h.ledger_kind = 'fee'))
  and h.swap_group_id is null and h.settles_transaction_id is null and h.fee_of is null
  and (h.transfer_review is null or h.transfer_review in ('left_control', 'fee'))
  and h.quantity ~ '^-(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:[eE][+-]?[0-9]+)?$'
  and split_part(lower(h.quantity), 'e', 1) ~ '[1-9]'`;
