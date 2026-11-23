import type { DatabaseTransaction } from '@scani/db';
import type { RuleScope, SavedCategoryRule } from '@scani/shared';
import { type SQL, sql } from 'drizzle-orm';
import { CategoryRuleError } from '../services/categories/category-rule-errors';
import { CUSTOM_RULE_ELIGIBLE } from '../services/categories/custom-rule-eligibility';
export async function ruleRows<T>(db: DatabaseTransaction, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

type Category = {
  id: string;
  userId: string;
  parentId: string | null;
  name?: string;
  color?: string | null;
};
type MaterialRow = {
  id: string;
  holdingId: string;
  tokenId: string;
  typeId: string;
  categoryId: string | null;
  categorySetBy: string | null;
  ruleId: string | null;
  targetId: string | null;
  key: string | null;
  eligible: boolean;
  occurredAt: string;
  payee: string;
  amount: string;
  currency: string;
  fingerprint: string;
};
export type Materialization = {
  rows: Array<Omit<MaterialRow, 'fingerprint'> & { hash: string }>;
  categories: Category[];
  rules: SavedCategoryRule[];
  account: { id: string; userId: string; name?: string } | null;
  valid: boolean;
};
function uuidList(ids: string[]): SQL {
  return ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `
      )}]::uuid[]`
    : sql`array[]::uuid[]`;
}
function utc(column: string): SQL {
  return sql`to_char(${sql.raw(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
// Version 1 is explicit: new ledger columns cannot silently change retained receipts.
const columns =
  `id user_id holding_id token_id kind quantity price_native price_native_token_id counter_token_id counter_quantity counter_price_native counter_price_native_token_id fee_quantity fee_token_id occurred_at external_id swap_group_id transfer_group_id settles_transaction_id transfer_review transfer_reviewed_at transfer_review_source transfer_review_rule_id transfer_review_split source source_metadata raw_payload counterparty description ledger_kind kind_subtype group_id fee_of input_id execution_price execution_price_token_id kind_origin decision_id category_id category_set_by created_at updated_at`.split(
    ' '
  );
const timestamps = new Set(['occurred_at', 'transfer_reviewed_at', 'created_at', 'updated_at']);
const transactionProjection = sql`jsonb_build_object(${sql.join(
  columns.flatMap((c) => [sql`${c}::text`, timestamps.has(c) ? utc(`h.${c}`) : sql.raw(`h.${c}`)]),
  sql`, `
)})`;

export async function materialize(
  db: DatabaseTransaction,
  userId: string,
  scope: RuleScope,
  ids?: string[],
  undo = false,
  priorIds: string[] = []
): Promise<Materialization> {
  const ruleQuery = undo
    ? sql`select null::uuid id, null::uuid user_id, null::uuid account_id, null::text payee_key, null::uuid category_id, false enabled, 0 revision where false`
    : sql`select id,user_id,account_id,payee_key,category_id,enabled,revision from transaction_category_rules where user_id = ${userId} and account_id = ${scope.accountId}`;
  const [raw] = await ruleRows<{
    value: {
      rows: MaterialRow[];
      categories: Category[];
      rules: SavedCategoryRule[];
      account: Materialization['account'];
      valid: boolean;
    };
  }>(
    db,
    sql`
    with recursive rules as (${ruleQuery}),
    selected as (
      select h.*, holding.account_id dep_account_id, holding.user_id dep_owner, holding.token_id dep_token_id,
        token.type_id dep_type_id, token_type.code dep_type_code, token.symbol dep_symbol,
        r.id rule_id, r.category_id target_id, r.payee_key rule_key,
        coalesce((${CUSTOM_RULE_ELIGIBLE}), false) eligible,
        (${transactionProjection}) transaction_projection
      from holding_transactions h
      left join holdings holding on holding.id = h.holding_id
      left join accounts account on account.id = holding.account_id
      left join tokens token on token.id = h.token_id
      left join token_types token_type on token_type.id = token.type_id
      left join rules r on r.enabled and r.account_id = holding.account_id and r.payee_key = transaction_payee_key(h.counterparty, h.description)
      where h.user_id = ${userId} and ${ids !== undefined ? sql`h.id = any(${uuidList(ids)})` : sql`holding.account_id = ${scope.accountId} and account.user_id = ${userId} and h.occurred_at >= ${scope.from}::timestamptz and h.occurred_at < ${scope.to}::timestamptz and r.id is not null and (${CUSTOM_RULE_ELIGIBLE})`}
      order by h.id ${ids === undefined ? sql`limit 501` : sql``}
    ), seeds as (
      select category_id id from selected where category_id is not null
      union select target_id from selected where target_id is not null
      union select unnest(${uuidList(priorIds)})
    ), paths as (
      select c.*, array[c.id] visited, false cycle from transaction_categories c join seeds s on s.id = c.id
      ${undo ? sql`` : sql`union all select c.*, p.visited || c.id, c.id = any(p.visited) from transaction_categories c join paths p on c.id = p.parent_id where not p.cycle`}
    ), categories as (select distinct id, user_id, parent_id, name, color from paths),
    owner_account as (select id, user_id, name from accounts where id = ${scope.accountId} and user_id = ${userId})
    select jsonb_build_object(
      'account', (select ${undo ? sql`jsonb_build_object('id', id, 'userId', user_id)` : sql`jsonb_build_object('id', id, 'userId', user_id, 'name', name)`} from owner_account),
      'rules', coalesce((select jsonb_agg(jsonb_build_object('id',id,'userId',user_id,'accountId',account_id,'payeeKey',payee_key,'categoryId',category_id,'enabled',enabled,'revision',revision) order by id) from rules), '[]'::jsonb),
      'categories', coalesce((select jsonb_agg(${undo ? sql`jsonb_build_object('id',id,'userId',user_id)` : sql`jsonb_build_object('id',id,'userId',user_id,'parentId',parent_id,'name',name,'color',color)`} order by id) from categories), '[]'::jsonb),
      'valid', not exists(select 1 from seeds s where not exists(select 1 from categories c where c.id = s.id and c.user_id = ${userId}))
        ${undo ? sql`` : sql`and not exists(select 1 from paths p where p.cycle or (p.parent_id is not null and not exists(select 1 from categories c where c.id = p.parent_id and c.user_id = ${userId})))`},
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'holdingId', h.holding_id, 'tokenId', h.token_id, 'typeId', h.dep_type_id,
        'categoryId', h.category_id, 'categorySetBy', h.category_set_by,
        'ruleId', h.rule_id, 'targetId', h.target_id, 'key', h.rule_key, 'eligible', h.eligible,
        'occurredAt', ${utc('h.occurred_at')}, 'payee', coalesce(h.counterparty,h.description,''),
        'amount', h.quantity, 'currency', h.dep_symbol,
        'fingerprint', jsonb_build_object('version',1,'transaction',h.transaction_projection,
          'holding',jsonb_build_object('id',h.holding_id,'userId',h.dep_owner,'accountId',h.dep_account_id,'tokenId',h.dep_token_id),
          'token',${undo ? sql`jsonb_build_object('id',h.token_id,'typeId',h.dep_type_id)` : sql`jsonb_build_object('id',h.token_id,'typeId',h.dep_type_id,'symbol',h.dep_symbol)`},
          'type',jsonb_build_object('id',h.dep_type_id,'code',h.dep_type_code))::text
      ) order by h.id) from selected h), '[]'::jsonb)
    ) value`
  );
  if (!raw) throw new CategoryRuleError('BUSY');
  return {
    ...raw.value,
    rows: raw.value.rows.map(({ fingerprint, ...row }) => ({
      ...row,
      hash: new Bun.CryptoHasher('sha256').update(fingerprint).digest('hex'),
    })),
  };
}

export function dependencyIds(m: Materialization) {
  const sorted = (values: string[]) => [...new Set(values)].sort();
  return {
    categories: sorted(m.categories.map((c) => c.id)),
    holdings: sorted(m.rows.map((r) => r.holdingId)),
    tokens: sorted(m.rows.map((r) => r.tokenId)),
    tokenTypes: sorted(m.rows.map((r) => r.typeId)),
    transactions: sorted(m.rows.map((r) => r.id)),
  };
}
export async function lockDependencies(db: DatabaseTransaction, m: Materialization) {
  const ids = dependencyIds(m);
  const locks: Array<[string, string[], string]> = [
    ['transaction_categories', ids.categories, 'share'],
    ['holdings', ids.holdings, 'share'],
    ['tokens', ids.tokens, 'share'],
    ['token_types', ids.tokenTypes, 'share'],
    ['holding_transactions', ids.transactions, 'update'],
  ];
  for (const [table, set, mode] of locks) {
    if (set.length)
      await db.execute(
        sql`select id from ${sql.raw(table)} where id = any(${uuidList(set)}) order by id for ${sql.raw(mode)}`
      );
  }
}
