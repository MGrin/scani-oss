import { type DatabaseTransaction, getDb } from '@scani/db';
import {
  type CategorySpendingInput,
  type CategorySpendingReport,
  categorySpendingInputSchema,
} from '@scani/shared';
import { sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { customTokenVisibleTo } from '../../lib/custom-token-visibility';
import { ledgerOrderBy } from '../../lib/ledger-order';

export class CategorySpendingNotFoundError extends Error {
  constructor() {
    super('Spending selection not found.');
  }
}
export class CategorySpendingDataError extends Error {
  constructor() {
    super('Spending data needs attention. Check your recorded transactions.');
  }
}

// Spending is independent of rule applicability; metadata-only settlement fees are not consumption.
const SPENDING_CANDIDATE = sql`((h.kind = 'withdraw' and h.ledger_kind = 'outflow')
  or (h.kind = 'fee' and h.ledger_kind = 'fee'))
  and h.transfer_group_id is null and h.swap_group_id is null
  and h.settles_transaction_id is null and h.fee_of is null
  and not (jsonb_typeof(h.source_metadata) = 'object' and h.source_metadata ? 'settles')
  and (h.transfer_review is null or h.transfer_review in ('left_control', 'fee'))`;
const NUMERIC_TEXT = '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$';

@Service()
export class CategorySpendingService {
  async read(
    userId: string,
    rawInput: CategorySpendingInput,
    transaction?: DatabaseTransaction
  ): Promise<CategorySpendingReport> {
    const input = categorySpendingInputSchema.parse(rawInput);
    const now = new Date();
    const from = new Date(`${input.month}-01T00:00:00.000Z`);
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 1);
    const effectiveTo = new Date(Math.min(now.getTime(), to.getTime()));
    const detail = input.detail;
    const category = detail?.category;
    const isRoot = category !== undefined && category !== 'all' && category !== 'uncategorized';
    const categoryFilter =
      category === 'uncategorized'
        ? sql`e.root_id is null`
        : isRoot
          ? sql`e.root_id = ${category}::uuid`
          : sql`true`;
    try {
      const result = await (transaction ?? getDb()).execute(sql`
        with owned_accounts as (
          select a.id, a.name, a.is_active, i.name institution_name
          from accounts a join account_types at on at.id = a.type_id
          join institutions i on i.id = a.institution_id
          where a.user_id = ${userId} and not a.is_hidden
            and at.class = 'asset' and at.code not in ('investment', 'crypto')
        ), scoped as (
          select h.*, a.name account_name, a.institution_name, not a.is_active account_inactive,
            not holding.is_active holding_inactive, token.symbol, token.name token_name,
            c.id assigned_id, c.parent_id, coalesce(p.id,c.id) root_id,
            case when c.parent_id is not null then p.name else c.name end root_name,
            case when c.parent_id is not null then p.color else c.color end root_color,
            case when c.parent_id is not null then p.name || ' › ' || c.name else c.name end category_path,
            coalesce(c.color,p.color) category_color,
            (h.category_id is not null and (c.id is null or (c.parent_id is not null and (p.id is null or p.parent_id is not null)))) category_invalid,
            (${SPENDING_CANDIDATE}) candidate
          from holding_transactions h
          join holdings holding on holding.id = h.holding_id and holding.user_id = ${userId} and holding.user_id = h.user_id and holding.token_id = h.token_id
          join owned_accounts a on a.id = holding.account_id
          join tokens token on token.id = h.token_id
          join token_types tt on tt.id = token.type_id and tt.code = 'fiat'
          left join transaction_categories c on c.id = h.category_id and c.user_id = ${userId}
          left join transaction_categories p on p.id = c.parent_id and p.user_id = ${userId}
          where h.user_id = ${userId} and ${customTokenVisibleTo(userId, 'token')}
            and (not holding.is_hidden or holding.hidden_by = 'auto')
            and h.occurred_at >= ${from.toISOString()}::timestamptz
            and h.occurred_at < ${to.toISOString()}::timestamptz
            and h.occurred_at <= ${now.toISOString()}::timestamptz
            ${input.accountId ? sql`and a.id = ${input.accountId}::uuid` : sql``}
        ), amounts as (
          select *, case when candidate and quantity ~ ${NUMERIC_TEXT} then quantity::numeric else null end signed_amount
          from scoped
        ), eligible as (
          select *, -signed_amount amount from amounts where candidate and signed_amount < 0
        ), buckets as (
          select token_id, symbol, token_name, root_id, root_name, root_color,
            sum(amount) total, count(*)::int count,
            count(*) filter(where kind = 'withdraw' and transfer_review is null)::int unreviewed
          from eligible group by token_id, symbol, token_name, root_id, root_name, root_color
        ), currencies as (
          select token_id, symbol, token_name, sum(total) total, sum(count)::int count, sum(unreviewed)::int unreviewed,
            jsonb_agg(jsonb_build_object('categoryId',root_id,'name',root_name,'color',root_color,'total',trim_scale(total)::text,'count',count)
              order by root_id is null, total desc, root_name collate "C", root_id) categories
          from buckets group by token_id, symbol, token_name
        ), detail_rows as (
          select e.*, row_number() over(order by ${sql.join(ledgerOrderBy('desc'), sql`, `)}) row_order
          from eligible e join holding_transactions on holding_transactions.id = e.id
          where ${Boolean(detail)} and e.token_id = ${detail?.tokenId ?? null}::uuid and ${categoryFilter}
        ), page as (
          select * from detail_rows order by row_order limit 51 offset ${detail?.offset ?? 0}
        )
        select
          (${input.accountId === undefined} or exists(select 1 from owned_accounts where id = ${input.accountId ?? null}::uuid)) account_valid,
          (${!isRoot} or exists(select 1 from transaction_categories where id = ${isRoot ? category : null}::uuid and user_id = ${userId} and parent_id is null)) category_valid,
          (${!detail} or exists(select 1 from currencies where token_id = ${detail?.tokenId ?? null}::uuid)) token_valid,
          (select name from transaction_categories where id = ${isRoot ? category : null}::uuid and user_id = ${userId} and parent_id is null) detail_category_name,
          exists(select 1 from amounts where candidate and signed_amount is null) invalid_amount,
          exists(select 1 from eligible where category_invalid) invalid_category,
          coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',institution_name || ' · ' || name,'isActive',is_active) order by name collate "C",id) from owned_accounts),'[]'::jsonb) accounts,
          coalesce((select jsonb_agg(jsonb_build_object('tokenId',token_id,'symbol',symbol,'name',token_name,'total',trim_scale(total)::text,'count',count,'unreviewedCount',unreviewed,'categories',categories) order by symbol collate "C",token_id) from currencies),'[]'::jsonb) currencies,
          (select count(*)::int from scoped where transfer_review = 'split' and kind in ('withdraw','transfer_out')) excluded_split_count,
          (select count(*)::int from scoped where ledger_kind is null and kind in ('withdraw','fee')) excluded_unclassified_count,
          coalesce((select trim_scale(sum(amount))::text from detail_rows),'0') detail_total,
          (select count(*)::int from detail_rows) detail_count,
          coalesce((select jsonb_agg(jsonb_build_object(
            'id',id,'occurredAt',to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'quantity',quantity,'description',description,'counterparty',counterparty,
            'accountName',institution_name || ' · ' || account_name,'accountInactive',account_inactive,'holdingInactive',holding_inactive,
            'tokenId',token_id,'symbol',symbol,'categoryPath',category_path,'categoryColor',category_color,'categorySetBy',category_set_by
          ) order by row_order) from (select * from page order by row_order limit 50) rows),'[]'::jsonb) rows,
          (select count(*) > 50 from page) more
      `);
      const row = result[0] as unknown as {
        account_valid: boolean;
        category_valid: boolean;
        token_valid: boolean;
        invalid_amount: boolean;
        invalid_category: boolean;
        accounts: CategorySpendingReport['accounts'];
        currencies: CategorySpendingReport['currencies'];
        excluded_split_count: number;
        excluded_unclassified_count: number;
        detail_category_name: string | null;
        detail_total: string;
        detail_count: number;
        rows: NonNullable<CategorySpendingReport['detail']>['rows'];
        more: boolean;
      };
      if (!row.account_valid || !row.category_valid) throw new CategorySpendingNotFoundError();
      if (row.invalid_amount || row.invalid_category) throw new CategorySpendingDataError();
      if (!row.token_valid) throw new CategorySpendingNotFoundError();
      return {
        month: input.month,
        from: from.toISOString(),
        to: to.toISOString(),
        effectiveTo: effectiveTo.toISOString(),
        generatedAt: now.toISOString(),
        accounts: row.accounts,
        currencies: row.currencies,
        excludedSplitCount: row.excluded_split_count,
        excludedUnclassifiedCount: row.excluded_unclassified_count,
        detail: detail
          ? {
              categoryName: row.detail_category_name,
              total: row.detail_total,
              count: row.detail_count,
              rows: row.rows,
              nextOffset: row.more ? detail.offset + 50 : null,
            }
          : null,
      };
    } catch (error) {
      const code =
        (error as { cause?: { code?: string }; code?: string }).cause?.code ??
        (error as { code?: string }).code;
      if (code === '22003' || code === '22P02') throw new CategorySpendingDataError();
      throw error;
    }
  }
}
