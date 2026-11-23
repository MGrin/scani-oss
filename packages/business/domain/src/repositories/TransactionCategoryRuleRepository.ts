import { type DatabaseTransaction, getDb } from '@scani/db';
import type {
  CategoryRuleSave,
  RuleApplyResult,
  RulePreview,
  RuleRecentOperations,
  RuleScope,
  RuleUndoResult,
  SavedCategoryRule,
} from '@scani/shared';
import { type SQL, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { CategoryRuleError } from '../services/categories/category-rule-errors';
import {
  dependencyIds,
  lockDependencies,
  type Materialization,
  materialize,
} from './category-rule-materialization';

const ruleFields = sql`id, payee_key as "payeeKey", account_id as "accountId", category_id as "categoryId", enabled, revision`;
export async function ruleRows<T>(db: DatabaseTransaction, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: unknown };
  return e?.code ?? (e?.cause ? sqlState(e.cause) : undefined);
}

@Service()
export class TransactionCategoryRuleRepository {
  async transaction<T>(
    userId: string,
    fn: (tx: DatabaseTransaction) => Promise<T>,
    outer?: DatabaseTransaction
  ): Promise<T> {
    try {
      const work = async (tx: DatabaseTransaction) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        await tx.execute(sql`set local statement_timeout = '3s'`);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${'category-rules:' + userId}, 0))`
        );
        const users = await ruleRows(
          tx,
          sql`select id from users where id = ${userId} order by id for key share`
        );
        if (!users.length) throw new CategoryRuleError('NOT_FOUND');
        return await fn(tx);
      };
      return outer
        ? await outer.transaction(work)
        : await getDb().transaction(work, { isolationLevel: 'read committed' });
    } catch (error) {
      const code = sqlState(error);
      if (code && ['55P03', '57014', '40P01', '40001'].includes(code))
        throw new CategoryRuleError('BUSY');
      if (code === '23505') throw new CategoryRuleError('DUPLICATE_RULE');
      if (code === '23503') throw new CategoryRuleError('NOT_FOUND');
      if (error instanceof CategoryRuleError) throw error;
      throw new CategoryRuleError('BUSY');
    }
  }

  async list(userId: string, tx?: DatabaseTransaction): Promise<SavedCategoryRule[]> {
    return ruleRows(
      tx ?? getDb(),
      sql`select ${ruleFields} from transaction_category_rules where user_id = ${userId} order by id`
    );
  }

  async save(
    userId: string,
    input: CategoryRuleSave,
    outer?: DatabaseTransaction
  ): Promise<SavedCategoryRule> {
    return this.transaction(
      userId,
      async (tx) => {
        const rules = await ruleRows<SavedCategoryRule>(
          tx,
          sql`select ${ruleFields} from transaction_category_rules where user_id = ${userId} order by id for update`
        );
        const current = input.id ? rules.find((r) => r.id === input.id) : undefined;
        if (input.id && !current) throw new CategoryRuleError('NOT_FOUND');
        if (current && current.revision !== input.expectedRevision)
          throw new CategoryRuleError('REVISION_CONFLICT');
        const accounts = await ruleRows(
          tx,
          sql`select id from accounts where id = ${input.accountId} and user_id = ${userId} for share`
        );
        const categories = await ruleRows(
          tx,
          sql`select id from transaction_categories where id = ${input.categoryId} and user_id = ${userId} for share`
        );
        if (!accounts.length || !categories.length) throw new CategoryRuleError('NOT_FOUND');
        const [normalized] = await ruleRows<{ key: string | null }>(
          tx,
          sql`select transaction_payee_key(${input.payeeText}, null) as key`
        );
        if (!normalized?.key) throw new CategoryRuleError('INVALID_RULE');
        if (
          rules.some(
            (r) =>
              r.id !== input.id && r.accountId === input.accountId && r.payeeKey === normalized.key
          )
        )
          throw new CategoryRuleError('DUPLICATE_RULE');
        if (!current && rules.length >= 100) throw new CategoryRuleError('RULE_LIMIT');
        const [row] = await ruleRows<SavedCategoryRule>(
          tx,
          current
            ? sql`update transaction_category_rules set payee_key = ${normalized.key}, account_id = ${input.accountId}, category_id = ${input.categoryId}, enabled = ${input.enabled}, revision = revision + 1, updated_at = clock_timestamp() where id = ${current.id} and user_id = ${userId} returning ${ruleFields}`
            : sql`insert into transaction_category_rules (user_id, account_id, category_id, payee_key, enabled) values (${userId}, ${input.accountId}, ${input.categoryId}, ${normalized.key}, ${input.enabled}) returning ${ruleFields}`
        );
        if (!row) throw new CategoryRuleError('NOT_FOUND');
        return row;
      },
      outer
    );
  }

  async remove(
    userId: string,
    id: string,
    expectedRevision: number,
    outer?: DatabaseTransaction
  ): Promise<void> {
    await this.transaction(
      userId,
      async (tx) => {
        const [rule] = await ruleRows<SavedCategoryRule>(
          tx,
          sql`select ${ruleFields} from transaction_category_rules where user_id = ${userId} and id = ${id} for update`
        );
        if (!rule) throw new CategoryRuleError('NOT_FOUND');
        if (rule.revision !== expectedRevision) throw new CategoryRuleError('REVISION_CONFLICT');
        await tx.execute(
          sql`delete from transaction_category_rules where id = ${id} and user_id = ${userId}`
        );
      },
      outer
    );
  }
  private async operations(tx: DatabaseTransaction, userId: string): Promise<Run[]> {
    return ruleRows<Run>(
      tx,
      sql`select id, status, scope, snapshot, candidates,
      candidate_ids as "candidateIds", changed_ids as "changedIds", projection_version as version,
      to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt",
      expires_at <= clock_timestamp() expired
      from transaction_category_rule_runs where user_id = ${userId} order by id for update`
    );
  }
  private async scopeLocks(
    tx: DatabaseTransaction,
    userId: string,
    scope: RuleScope,
    undo = false
  ): Promise<void> {
    if (!undo)
      await tx.execute(
        sql`select id from transaction_category_rules where user_id = ${userId} and account_id = ${scope.accountId} order by id for share`
      );
    const rows = await ruleRows(
      tx,
      sql`select id from accounts where id = ${scope.accountId} and user_id = ${userId} for share`
    );
    if (!rows.length) throw new CategoryRuleError(undo ? 'UNDO_CONFLICT' : 'NOT_FOUND');
  }
  async preview(
    userId: string,
    scope: RuleScope,
    outer?: DatabaseTransaction
  ): Promise<RulePreview> {
    return this.transaction(
      userId,
      async (tx) => {
        const runs = await this.operations(tx, userId);
        await tx.execute(
          sql`delete from transaction_category_rule_runs where user_id = ${userId} and status = 'preview' and expires_at <= clock_timestamp()`
        );
        if (runs.filter((r) => r.status === 'preview' && !r.expired).length >= 3)
          throw new CategoryRuleError('PREVIEW_LIMIT');
        await this.scopeLocks(tx, userId, scope);
        const discovery = await materialize(tx, userId, scope);
        if (discovery.rows.length > 500) throw new CategoryRuleError('TOO_MANY_ROWS');
        if (!discovery.valid || !discovery.account) throw new CategoryRuleError('BUSY');
        await lockDependencies(tx, discovery);
        const final = await materialize(
          tx,
          userId,
          scope,
          discovery.rows.map((r) => r.id)
        );
        if (!same(discovery, final) || !final.valid) throw new CategoryRuleError('BUSY');
        const changed = final.rows.filter(changes);
        const [created] = await ruleRows<{ id: string; expiresAt: string }>(
          tx,
          sql`insert into transaction_category_rule_runs
        (user_id, scope, snapshot, candidate_ids, changed_ids, candidates, expires_at)
        values (${userId}, ${JSON.stringify(scope)}::jsonb, ${JSON.stringify(snapshot(final))}::jsonb,
          ${JSON.stringify(final.rows.map((r) => r.id))}::jsonb, ${JSON.stringify(changed.map((r) => r.id))}::jsonb,
          ${JSON.stringify(final.rows)}::jsonb, clock_timestamp() + interval '15 minutes')
        returning id, to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "expiresAt"`
        );
        if (!created) throw new CategoryRuleError('BUSY');
        const path = (id: string | null): string | null => {
          if (!id) return null;
          const names: string[] = [];
          let current: string | null = id;
          while (current) {
            const node = final.categories.find((c) => c.id === current);
            if (!node) throw new CategoryRuleError('BUSY');
            names.unshift(node.name ?? '');
            current = node.parentId;
          }
          return names.join(' › ');
        };
        return {
          previewId: created.id,
          expiresAt: created.expiresAt,
          scope,
          accountName: final.account?.name ?? '',
          matched: final.rows.length,
          protected: final.rows.filter(protectedRow).length,
          unchanged: final.rows.length - changed.length - final.rows.filter(protectedRow).length,
          changed: changed.length,
          rows: changed.map((r) => ({
            transactionId: r.id,
            occurredAt: r.occurredAt,
            payee: r.payee,
            amount: r.amount,
            currency: r.currency,
            beforeCategoryId: r.categoryId,
            beforeCategoryLabel: path(r.categoryId),
            afterCategoryId: r.targetId as string,
            afterCategoryLabel: path(r.targetId) as string,
            ruleId: r.ruleId as string,
            rulePayeeKey: r.key as string,
            provenanceOnly: r.categoryId === r.targetId,
            beforeCategoryColor: final.categories.find((c) => c.id === r.categoryId)?.color ?? null,
            afterCategoryColor: final.categories.find((c) => c.id === r.targetId)?.color ?? null,
          })),
        };
      },
      outer
    );
  }
  async apply(userId: string, id: string, outer?: DatabaseTransaction): Promise<RuleApplyResult> {
    return this.transaction(
      userId,
      async (tx) => {
        const runs = await this.operations(tx, userId);
        const run = runs.find((r) => r.id === id);
        if (!run) throw new CategoryRuleError('NOT_FOUND');
        if (run.status === 'undone') throw new CategoryRuleError('ALREADY_UNDONE');
        if (run.status === 'applied')
          return { operationId: id, changed: run.changedIds.length, replayed: true };
        if (run.expired) throw new CategoryRuleError('PREVIEW_EXPIRED');
        if (!run.changedIds.length) throw new CategoryRuleError('NO_CHANGES');
        if (run.version !== 1) throw new CategoryRuleError('STALE_PREVIEW');
        try {
          await this.scopeLocks(tx, userId, run.scope);
        } catch (e) {
          if (e instanceof CategoryRuleError && e.code === 'NOT_FOUND')
            throw new CategoryRuleError('STALE_PREVIEW');
          throw e;
        }
        const stored: Materialization = { ...run.snapshot, rows: run.candidates, valid: true };
        await lockDependencies(tx, stored);
        const final = await materialize(tx, userId, run.scope, run.candidateIds);
        if (!final.valid || !same(stored, final)) throw new CategoryRuleError('STALE_PREVIEW');
        const changed = final.rows.filter((r) => run.changedIds.includes(r.id));
        for (const row of changed) {
          const written = await ruleRows<{ id: string }>(
            tx,
            sql`update holding_transactions set category_id = ${row.targetId}, category_set_by = 'custom_rule', updated_at = clock_timestamp()
          where id = ${row.id} and user_id = ${userId} returning id`
          );
          if (written.length !== 1 || written[0]?.id !== row.id)
            throw new CategoryRuleError('STALE_PREVIEW');
        }
        const prior = changed.flatMap((r) => (r.categoryId ? [r.categoryId] : []));
        const after = await materialize(tx, userId, run.scope, run.changedIds, true, prior);
        if (
          !after.valid ||
          !sameIds(
            after.rows.map((r) => r.id),
            run.changedIds
          )
        )
          throw new CategoryRuleError('STALE_PREVIEW');
        const result = { operationId: id, changed: changed.length, replayed: false };
        await tx.execute(
          sql`update transaction_category_rule_runs set status = 'applied', applied_at = clock_timestamp(), result = ${JSON.stringify({ apply: result, after })}::jsonb where id = ${id} and user_id = ${userId}`
        );
        await tx.execute(sql`delete from transaction_category_rule_runs where user_id = ${userId} and id in (
        select id from transaction_category_rule_runs where user_id = ${userId} and status in ('applied', 'undone') order by applied_at desc, id desc offset 20)`);
        return result;
      },
      outer
    );
  }
  async undo(userId: string, id: string, outer?: DatabaseTransaction): Promise<RuleUndoResult> {
    return this.transaction(
      userId,
      async (tx) => {
        const runs = await this.operations(tx, userId);
        const run = runs.find((r) => r.id === id);
        if (!run) throw new CategoryRuleError('NOT_FOUND');
        if (run.status === 'preview') throw new CategoryRuleError('UNDO_CONFLICT');
        if (run.status === 'undone')
          return { operationId: id, restored: run.changedIds.length, replayed: true };
        if (run.version !== 1) throw new CategoryRuleError('UNDO_CONFLICT');
        const [receipt] = await ruleRows<{ result: { after: Materialization } }>(
          tx,
          sql`select result from transaction_category_rule_runs where id = ${id} and user_id = ${userId}`
        );
        if (!receipt) throw new CategoryRuleError('NOT_FOUND');
        await this.scopeLocks(tx, userId, run.scope, true);
        const prior = run.candidates
          .filter((r) => run.changedIds.includes(r.id))
          .flatMap((r) => (r.categoryId ? [r.categoryId] : []));
        const discovery = await materialize(tx, userId, run.scope, run.changedIds, true, prior);
        await lockDependencies(tx, discovery);
        const final = await materialize(tx, userId, run.scope, run.changedIds, true, prior);
        if (!final.valid || !sameUndo(discovery, final) || !sameUndo(receipt.result.after, final))
          throw new CategoryRuleError('UNDO_CONFLICT');
        for (const row of run.candidates.filter((r) => run.changedIds.includes(r.id))) {
          const written = await ruleRows<{ id: string }>(
            tx,
            sql`update holding_transactions set category_id = ${row.categoryId}, category_set_by = ${row.categorySetBy}, updated_at = clock_timestamp() where id = ${row.id} and user_id = ${userId} returning id`
          );
          if (written.length !== 1 || written[0]?.id !== row.id)
            throw new CategoryRuleError('UNDO_CONFLICT');
        }
        await tx.execute(
          sql`update transaction_category_rule_runs set status = 'undone', undone_at = clock_timestamp() where id = ${id} and user_id = ${userId}`
        );
        return { operationId: id, restored: run.changedIds.length, replayed: false };
      },
      outer
    );
  }
  async recent(userId: string, tx?: DatabaseTransaction): Promise<RuleRecentOperations> {
    const items = await ruleRows<RuleRecentOperations['items'][number]>(
      tx ?? getDb(),
      sql`select id as "operationId", status,
      jsonb_array_length(changed_ids) changed,
      to_char(applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "appliedAt",
      to_char(undone_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "undoneAt"
      from transaction_category_rule_runs where user_id = ${userId} and status in ('applied', 'undone') order by applied_at desc, id desc limit 20`
    );
    return { items };
  }
}

type Run = {
  id: string;
  status: 'preview' | 'applied' | 'undone';
  scope: RuleScope;
  snapshot: ReturnType<typeof snapshot>;
  candidates: Materialization['rows'];
  candidateIds: string[];
  changedIds: string[];
  expiresAt: string;
  expired: boolean;
  version: number;
};
function snapshot(m: Materialization) {
  return { account: m.account, categories: m.categories, rules: m.rules };
}
function protectedRow(r: Materialization['rows'][number]) {
  return ['person', 'cleared', 'import'].includes(r.categorySetBy ?? '');
}
function changes(r: Materialization['rows'][number]) {
  return (
    r.eligible &&
    r.ruleId !== null &&
    !protectedRow(r) &&
    !(r.categoryId === r.targetId && r.categorySetBy === 'custom_rule')
  );
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function same(a: Materialization, b: Materialization) {
  return stable(a) === stable(b);
}
function sameIds(a: string[], b: string[]) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}
function sameUndo(a: Materialization, b: Materialization) {
  const projection = (m: Materialization) => ({
    account: m.account,
    categories: m.categories,
    ids: dependencyIds(m),
    rows: m.rows.map((r) => ({ id: r.id, hash: r.hash })),
  });
  return stable(projection(a)) === stable(projection(b));
}
