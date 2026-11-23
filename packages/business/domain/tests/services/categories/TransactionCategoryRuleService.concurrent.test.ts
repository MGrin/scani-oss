import { expect, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { TransactionCategoryRepository } from '../../../src/repositories/TransactionCategoryRepository';
import { TransactionCategoryRuleService } from '../../../src/services/categories/TransactionCategoryRuleService';
import { DeleteAllUserDataUseCase } from '../../../src/use-cases/DeleteAllUserDataUseCase';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function interceptedBuilder(
  builder: object,
  hook: (query: string, run: () => Promise<unknown>) => Promise<unknown>
): object {
  return new Proxy(builder, {
    get(target, prop) {
      const member = Reflect.get(target, prop);
      if (prop === 'then')
        return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
          const query = Reflect.apply(Reflect.get(target, 'toSQL'), target, []) as { sql: string };
          return hook(
            query.sql,
            () => new Promise((accept, refuse) => Reflect.apply(member, target, [accept, refuse]))
          ).then(resolve, reject);
        };
      if (typeof member === 'function')
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(member, target, args);
          return result !== null &&
            typeof result === 'object' &&
            typeof Reflect.get(result, 'then') === 'function'
            ? interceptedBuilder(result, hook)
            : result;
        };
      return member;
    },
  });
}
const dialect = new PgDialect();
function intercepted(
  tx: DatabaseTransaction,
  hook: (query: string, run: () => Promise<unknown>) => Promise<unknown>
): DatabaseTransaction {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === 'execute')
        return (query: SQL) =>
          hook(dialect.sqlToQuery(query).sql, async () => target.execute(query));
      if (prop === 'delete')
        return (...args: unknown[]) =>
          interceptedBuilder(Reflect.apply(target.delete, target, args) as object, hook);
      if (prop === 'transaction')
        return (fn: (inner: DatabaseTransaction) => Promise<unknown>) =>
          target.transaction((inner) => fn(intercepted(inner, hook)));
      const member = Reflect.get(target, prop);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}
async function setup() {
  return getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const [fiat] = await tx.execute(sql`select id from token_types where code = 'fiat'`);
    const token = await makeToken(tx, { typeId: (fiat as { id: string }).id });
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
    });
    const [parent] = await tx.execute(
      sql`insert into transaction_categories(user_id,name) values (${user.id}, 'Food') returning id`
    );
    const parentId = (parent as { id: string }).id;
    const [leaf] = await tx.execute(
      sql`insert into transaction_categories(user_id,name,parent_id) values (${user.id}, 'Cafes', ${parentId}) returning id`
    );
    const target = (leaf as { id: string }).id;
    const [old] = await tx.execute(
      sql`insert into transaction_categories(user_id,name) values (${user.id}, 'Old') returning id`
    );
    const oldId = (old as { id: string }).id;
    const row = await makeHoldingTransaction(tx, {
      userId: user.id,
      holdingId: holding.id,
      quantity: '-3.25',
      occurredAt: new Date('2026-11-10T12:00:00Z'),
      counterparty: 'Cafe Example',
      ledgerKind: 'outflow',
      categoryId: oldId,
      categorySetBy: 'ai',
    });
    const s = new TransactionCategoryRuleService();
    const rule = await s.save(
      user.id,
      { accountId: account.id, categoryId: target, payeeText: 'Cafe Example', enabled: true },
      tx
    );
    return {
      s,
      user,
      institution,
      account,
      token,
      holding,
      row,
      rule,
      parentId,
      oldId,
      target,
      scope: { accountId: account.id, from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' },
    };
  });
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function usingFixture(fn: (f: Fixture) => Promise<void>) {
  const f = await setup();
  try {
    await fn(f);
  } finally {
    await getDb().execute(sql`delete from transaction_category_rules where user_id = ${f.user.id}`);
    await getDb().execute(sql`delete from users where id = ${f.user.id}`);
    await getDb().execute(sql`delete from tokens where id = ${f.token.id}`);
    await getDb().execute(sql`delete from institutions where id = ${f.institution.id}`);
  }
}
async function blocked(pid: number) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const [row] = await getDb().execute(sql`select cardinality(pg_blocking_pids(${pid})) n`);
    if (Number((row as { n: number }).n) > 0) return;
    await Bun.sleep(10);
  }
  throw new Error('Writer never observed waiting on a database lock');
}

for (const [name, mutation] of [
  [
    'ancestor rename',
    (f: Fixture) =>
      sql`update transaction_categories set name = 'New name' where id = ${f.parentId}`,
  ],
  [
    'ancestor color',
    (f: Fixture) => sql`update transaction_categories set color = '#abc' where id = ${f.parentId}`,
  ],
  [
    'token type pointer',
    (f: Fixture) =>
      sql`update tokens set type_id = (select id from token_types where code = 'crypto') where id = ${f.token.id}`,
  ],
] as const) {
  test(`${name} before apply stales all writes`, async () =>
    usingFixture(async (f) => {
      const p = await f.s.preview(f.user.id, f.scope);
      await getDb().execute(mutation(f));
      await expect(f.s.apply(f.user.id, p.previewId)).rejects.toMatchObject({
        code: 'STALE_PREVIEW',
      });
      expect(
        (
          await getDb().execute(
            sql`select category_set_by from holding_transactions where id = ${f.row.id}`
          )
        )[0]
      ).toMatchObject({ category_set_by: 'ai' });
    }));
  test(`${name} after validation waits for apply commit`, async () =>
    usingFixture(async (f) => {
      const p = await f.s.preview(f.user.id, f.scope);
      const ready = deferred();
      const release = deferred();
      const writerReady = deferred();
      let writerPid = 0;
      const applying = getDb().transaction((tx) =>
        f.s.apply(
          f.user.id,
          p.previewId,
          intercepted(tx, async (query, run) => {
            const value = await run();
            if (query.includes('with recursive')) {
              ready.resolve();
              await release.promise;
            }
            return value;
          })
        )
      );
      await ready.promise;
      const writer = getDb().transaction(async (tx) => {
        const [pid] = await tx.execute(sql`select pg_backend_pid() pid`);
        writerPid = (pid as { pid: number }).pid;
        writerReady.resolve();
        await tx.execute(mutation(f));
      });
      try {
        await writerReady.promise;
        await blocked(writerPid);
      } finally {
        release.resolve();
      }
      expect(await applying).toMatchObject({ changed: 1 });
      await writer;
    }));
}
test('prior category deletion before undo refuses; category labels alone preserve undo', async () =>
  usingFixture(async (f) => {
    const p = await f.s.preview(f.user.id, f.scope);
    await f.s.apply(f.user.id, p.previewId);
    await getDb().execute(
      sql`update transaction_categories set name = 'Renamed' where id = ${f.target}`
    );
    await getDb().execute(sql`delete from transaction_categories where id = ${f.oldId}`);
    await expect(f.s.undo(f.user.id, p.previewId)).rejects.toMatchObject({ code: 'UNDO_CONFLICT' });
  }));
test('prior category deletion after undo validation waits', async () =>
  usingFixture(async (f) => {
    const p = await f.s.preview(f.user.id, f.scope);
    await f.s.apply(f.user.id, p.previewId);
    const ready = deferred();
    const release = deferred();
    const writerReady = deferred();
    let writerPid = 0;
    let reads = 0;
    const undoing = getDb().transaction((tx) =>
      f.s.undo(
        f.user.id,
        p.previewId,
        intercepted(tx, async (query, run) => {
          const value = await run();
          if (query.includes('with recursive') && ++reads === 2) {
            ready.resolve();
            await release.promise;
          }
          return value;
        })
      )
    );
    await ready.promise;
    const writer = getDb().transaction(async (tx) => {
      const [pid] = await tx.execute(sql`select pg_backend_pid() pid`);
      writerPid = (pid as { pid: number }).pid;
      writerReady.resolve();
      await tx.execute(sql`delete from transaction_categories where id = ${f.oldId}`);
    });
    try {
      await writerReady.promise;
      await blocked(writerPid);
    } finally {
      release.resolve();
    }
    expect(await undoing).toMatchObject({ restored: 1 });
    await writer;
  }));

test('holding cache and unrelated parent updates preserve preview and undo', async () =>
  usingFixture(async (f) => {
    const p = await f.s.preview(f.user.id, f.scope);
    await getDb().transaction((tx) =>
      seedHoldingCache(tx, (c) =>
        c.execute(
          sql`update holdings set balance = '200', value_base = '200', value_priced_at = clock_timestamp(), value_quote = '{"calculatedAt":"2026-11-23T00:00:00Z"}'::jsonb where id = ${f.holding.id}`
        )
      )
    );
    await getDb().execute(
      sql`update accounts set description = 'changed', updated_at = clock_timestamp() where id = ${f.account.id}`
    );
    await getDb().execute(
      sql`update holdings set label = 'new label', last_updated = clock_timestamp() where id = ${f.holding.id}`
    );
    expect(await f.s.apply(f.user.id, p.previewId)).toMatchObject({ changed: 1 });
    await getDb().transaction((tx) =>
      seedHoldingCache(tx, (c) =>
        c.execute(
          sql`update holdings set balance = '201', value_base = '202', value_priced_at = clock_timestamp(), value_quote = '{"calculatedAt":"2026-11-23T00:01:00Z"}'::jsonb where id = ${f.holding.id}`
        )
      )
    );
    await getDb().execute(
      sql`update token_types set display_order = display_order, updated_at = clock_timestamp() where id = ${f.token.typeId}`
    );
    await getDb().execute(
      sql`update accounts set name = 'new account name' where id = ${f.account.id}`
    );
    await getDb().execute(
      sql`update tokens set name = 'new token name', symbol = ${'RENAMED' + f.token.id}, updated_at = clock_timestamp() where id = ${f.token.id}`
    );
    await getDb().execute(
      sql`update transaction_categories set name = 'new old category' where id = ${f.oldId}`
    );
    expect(await f.s.undo(f.user.id, p.previewId)).toMatchObject({ restored: 1 });
  }));
test('discovery ancestor mutation returns BUSY with no persisted preview', async () =>
  usingFixture(async (f) => {
    let reads = 0;
    await expect(
      getDb().transaction((tx) =>
        f.s.preview(
          f.user.id,
          f.scope,
          intercepted(tx, async (query, run) => {
            const value = await run();
            if (query.includes('with recursive') && ++reads === 1)
              await getDb().execute(
                sql`update transaction_categories set color = '#abc' where id = ${f.parentId}`
              );
            return value;
          })
        )
      )
    ).rejects.toMatchObject({ code: 'BUSY' });
    const [n] = await getDb().execute(
      sql`select count(*)::int n from transaction_category_rule_runs where user_id = ${f.user.id}`
    );
    expect(n).toMatchObject({ n: 0 });
  }));
test('receipt failure rolls back ledger changes and concurrent apply commits once', async () =>
  usingFixture(async (f) => {
    const p = await f.s.preview(f.user.id, f.scope);
    await expect(
      getDb().transaction((tx) =>
        f.s.apply(
          f.user.id,
          p.previewId,
          intercepted(tx, async (query, run) => {
            if (query.includes("set status = 'applied'"))
              throw new Error('injected receipt failure');
            return run();
          })
        )
      )
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(
      (
        await getDb().execute(
          sql`select category_set_by from holding_transactions where id = ${f.row.id}`
        )
      )[0]
    ).toMatchObject({ category_set_by: 'ai' });
    const results = await Promise.all([
      f.s.apply(f.user.id, p.previewId),
      f.s.apply(f.user.id, p.previewId),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  }));
test('concurrent duplicate definitions and preview admission have bounded winners', async () =>
  usingFixture(async (f) => {
    const draft = {
      accountId: f.account.id,
      categoryId: f.target,
      payeeText: 'Another cafe',
      enabled: true,
    };
    const creates = await Promise.allSettled([
      f.s.save(f.user.id, draft),
      f.s.save(f.user.id, draft),
    ]);
    expect(creates.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (creates.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    ).toMatchObject({ code: 'DUPLICATE_RULE' });
    const previews = await Promise.allSettled(
      Array.from({ length: 4 }, () => f.s.preview(f.user.id, f.scope))
    );
    expect(previews.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(
      (previews.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    ).toMatchObject({ code: 'PREVIEW_LIMIT' });
  }));

test('protected and noop edits and locks never participate in undo', async () =>
  usingFixture(async (f) => {
    const extra = await getDb().transaction(async (tx) => {
      const base = {
        userId: f.user.id,
        holdingId: f.holding.id,
        occurredAt: f.row.occurredAt,
        counterparty: 'Cafe Example',
        ledgerKind: 'outflow',
      };
      const noop = await makeHoldingTransaction(tx, {
        ...base,
        categoryId: f.target,
        categorySetBy: 'custom_rule',
      });
      const protectedRow = await makeHoldingTransaction(tx, {
        ...base,
        categoryId: f.oldId,
        categorySetBy: 'import',
      });
      return { noop, protectedRow };
    });
    const p = await f.s.preview(f.user.id, f.scope);
    expect(p.changed).toBe(1);
    await f.s.apply(f.user.id, p.previewId);
    await getDb().execute(
      sql`delete from holding_transactions where id = ${extra.protectedRow.id}`
    );
    await f.s.remove(f.user.id, f.rule.id, 1);
    const ready = deferred();
    const release = deferred();
    const locker = getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select id from holding_transactions where id = ${extra.noop.id} for update`
      );
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    try {
      expect(await f.s.undo(f.user.id, p.previewId)).toMatchObject({ restored: 1 });
    } finally {
      release.resolve();
      await locker;
    }
  }));
test('expiry, replay and last twenty retention do not reapply evicted UUIDs', async () =>
  usingFixture(async (f) => {
    const expired = await f.s.preview(f.user.id, f.scope);
    await getDb().execute(
      sql`update transaction_category_rule_runs set expires_at = clock_timestamp() where id = ${expired.previewId}`
    );
    await expect(f.s.apply(f.user.id, expired.previewId)).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
    const ids: string[] = [];
    let revision = 1;
    for (let i = 0; i < 21; i++) {
      if (i)
        await f.s.save(f.user.id, {
          id: f.rule.id,
          expectedRevision: revision++,
          accountId: f.account.id,
          categoryId: i % 2 ? f.oldId : f.target,
          payeeText: 'Cafe Example',
          enabled: true,
        });
      const preview = await f.s.preview(f.user.id, f.scope);
      ids.push(preview.previewId);
      await f.s.apply(f.user.id, preview.previewId);
      if (i === 0) {
        await getDb().execute(
          sql`update transaction_category_rule_runs set expires_at = clock_timestamp() - interval '1 hour' where id = ${preview.previewId}`
        );
        expect(await f.s.apply(f.user.id, preview.previewId)).toMatchObject({ replayed: true });
      }
    }
    const recent = await f.s.recent(f.user.id);
    expect(recent.items).toHaveLength(20);
    expect(recent.items.map((r) => r.operationId)).toEqual(ids.slice(1).reverse());
    await expect(f.s.apply(f.user.id, ids[0] as string)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(f.s.undo(f.user.id, ids[0] as string)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const last = ids[20] as string;
    const timestamp = recent.items[0]?.appliedAt;
    await f.s.undo(f.user.id, last);
    expect((await f.s.recent(f.user.id)).items[0]).toMatchObject({
      operationId: last,
      status: 'undone',
      appliedAt: timestamp,
    });
  }));
test('application clock follows advisory acquisition rather than transaction start', async () =>
  usingFixture(async (f) => {
    await getDb().transaction(async (tx) => {
      await makeHoldingTransaction(tx, {
        userId: f.user.id,
        holdingId: f.holding.id,
        counterparty: 'Cafe Example',
        ledgerKind: 'outflow',
        occurredAt: new Date('2026-11-11T12:00:00Z'),
      });
    });
    const a = await f.s.preview(f.user.id, { ...f.scope, to: '2026-11-11T00:00:00Z' });
    const b = await f.s.preview(f.user.id, { ...f.scope, from: '2026-11-11T00:00:00Z' });
    const ready = deferred();
    const release = deferred();
    const earlierTransaction = getDb().transaction(async (tx) => {
      await tx.execute(sql`select now()`);
      ready.resolve();
      await release.promise;
      return f.s.apply(f.user.id, a.previewId, tx);
    });
    await ready.promise;
    try {
      await f.s.apply(f.user.id, b.previewId);
    } finally {
      release.resolve();
    }
    await earlierTransaction;
    const recent = (await f.s.recent(f.user.id)).items;
    expect(recent.map((r) => r.operationId)).toEqual([a.previewId, b.previewId]);
    expect((recent[0]?.appliedAt ?? '') > (recent[1]?.appliedAt ?? '')).toBe(true);
  }));
test('500 eligible candidates succeed; 501 refuses without persisting a partial preview', async () =>
  usingFixture(async (f) => {
    await getDb().execute(sql`insert into holding_transactions(user_id,holding_id,token_id,kind,ledger_kind,quantity,occurred_at,source,external_id,counterparty)
    select ${f.user.id},${f.holding.id},${f.token.id},'withdraw','outflow','-2','2026-11-10T12:00:00Z','fixture', g::text,'Cafe Example' from generate_series(1,499) g`);
    const preview = await f.s.preview(f.user.id, f.scope);
    expect(preview.matched).toBe(500);
    expect(preview.rows).toHaveLength(500);
    await getDb().execute(sql`insert into holding_transactions(user_id,holding_id,token_id,kind,ledger_kind,quantity,occurred_at,source,external_id,counterparty)
    values (${f.user.id},${f.holding.id},${f.token.id},'withdraw','outflow','-2','2026-11-10T12:00:00Z','fixture','overflow','Cafe Example')`);
    await expect(f.s.preview(f.user.id, f.scope)).rejects.toMatchObject({ code: 'TOO_MANY_ROWS' });
    const [count] = await getDb().execute(
      sql`select count(*)::int n from transaction_category_rule_runs where user_id = ${f.user.id}`
    );
    expect(count).toMatchObject({ n: 1 });
  }));
test('fiat negative outflow and fee controls exclude income, links, zero and invalid quantities', async () =>
  usingFixture(async (f) => {
    await getDb().transaction(async (tx) => {
      const base = {
        userId: f.user.id,
        holdingId: f.holding.id,
        counterparty: 'Cafe Example',
        occurredAt: f.row.occurredAt,
        ledgerKind: 'outflow',
      };
      const fee = await makeHoldingTransaction(tx, { ...base, kind: 'fee', ledgerKind: 'fee' });
      const positiveIds = [f.row.id, fee.id];
      for (const patch of [
        { kind: 'deposit', ledgerKind: 'inflow' },
        { kind: 'interest', ledgerKind: 'income' },
        { kind: 'reward', ledgerKind: 'income' },
        { kind: 'dividend', ledgerKind: 'income' },
        { kind: 'buy', ledgerKind: 'trade_leg' },
        { kind: 'correction', ledgerKind: 'unexplained_difference' },
        { ledgerKind: null },
        { quantity: '0' },
        { quantity: '-0.0e10' },
        { quantity: '2' },
        { quantity: 'invalid' },
        { feeOf: crypto.randomUUID() },
        { swapGroupId: crypto.randomUUID() },
        { transferGroupId: crypto.randomUUID() },
        { transferReview: 'paired' },
        { transferReview: 'internal' },
        { transferReview: 'untracked' },
        { transferReview: 'split', transferReviewSplit: { portions: [] } },
        { settlesTransactionId: f.row.id },
      ])
        await makeHoldingTransaction(tx, { ...base, ...patch });
      const preview = await f.s.preview(f.user.id, f.scope, tx);
      expect(preview.rows.map((r) => r.transactionId).sort()).toEqual(positiveIds.sort());
    });
  }));

for (const afterValidation of [false, true])
  test(`type code mutation respects validation lock; after=${afterValidation}`, async () =>
    usingFixture(async (f) => {
      const preview = await f.s.preview(f.user.id, f.scope);
      const setType = sql`update token_types set code = 'sc1652-not-fiat' where id = ${f.token.typeId}`;
      try {
        if (!afterValidation) {
          await getDb().execute(setType);
          await expect(f.s.apply(f.user.id, preview.previewId)).rejects.toMatchObject({
            code: 'STALE_PREVIEW',
          });
        } else {
          const ready = deferred();
          const release = deferred();
          const writerReady = deferred();
          let pid = 0;
          const applying = getDb().transaction((tx) =>
            f.s.apply(
              f.user.id,
              preview.previewId,
              intercepted(tx, async (query, run) => {
                const value = await run();
                if (query.includes('with recursive')) {
                  ready.resolve();
                  await release.promise;
                }
                return value;
              })
            )
          );
          await ready.promise;
          const writer = getDb().transaction(async (tx) => {
            const [row] = await tx.execute(sql`select pg_backend_pid() pid`);
            pid = (row as { pid: number }).pid;
            writerReady.resolve();
            await tx.execute(setType);
          });
          try {
            await writerReady.promise;
            await blocked(pid);
          } finally {
            release.resolve();
          }
          expect(await applying).toMatchObject({ changed: 1 });
          await writer;
        }
      } finally {
        await getDb().execute(
          sql`update token_types set code = 'fiat' where id = ${f.token.typeId}`
        );
      }
    }));
test('manual writer contention returns BUSY after rollback; unchanged input then succeeds', async () =>
  usingFixture(async (f) => {
    const preview = await f.s.preview(f.user.id, f.scope);
    const ready = deferred();
    const release = deferred();
    const writer = getDb().transaction(async (tx) => {
      await tx.execute(sql`select id from holding_transactions where id = ${f.row.id} for update`);
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    try {
      await expect(f.s.apply(f.user.id, preview.previewId)).rejects.toMatchObject({ code: 'BUSY' });
    } finally {
      release.resolve();
      await writer;
    }
    expect(await f.s.apply(f.user.id, preview.previewId)).toMatchObject({ changed: 1 });
  }));
test('apply response derives from the persisted final materialization without raw evidence', async () =>
  usingFixture(async (f) => {
    const preview = await f.s.preview(f.user.id, f.scope);
    const [stored] = await getDb().execute(
      sql`select snapshot,candidates,candidate_ids,changed_ids from transaction_category_rule_runs where id = ${preview.previewId}`
    );
    const record = stored as {
      snapshot: { categories: Array<{ id: string; name: string }> };
      candidates: Array<{ id: string; hash: string; amount: string; payee: string }>;
      candidate_ids: string[];
      changed_ids: string[];
    };
    expect(record.candidate_ids).toEqual(preview.rows.map((r) => r.transactionId));
    expect(record.changed_ids).toEqual(record.candidate_ids);
    expect(record.candidates[0]).toMatchObject({
      id: f.row.id,
      amount: '-3.25',
      payee: 'Cafe Example',
    });
    expect(record.candidates[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain('raw_payload');
    expect(JSON.stringify(record)).not.toContain('source_metadata');
  }));

test('SQL Cyrillic keys and digit-stripped description fallback use one normalizer', async () =>
  usingFixture(async (f) => {
    const cyrillic = await f.s.save(f.user.id, {
      accountId: f.account.id,
      categoryId: f.target,
      payeeText: 'МАГАЗИН ПРИМЕР',
      enabled: true,
    });
    expect(cyrillic.payeeKey).toBe('магазин пример');
    await getDb().transaction(async (tx) => {
      const base = {
        userId: f.user.id,
        holdingId: f.holding.id,
        occurredAt: f.row.occurredAt,
        ledgerKind: 'outflow',
      };
      await makeHoldingTransaction(tx, { ...base, counterparty: 'Магазин Пример' });
      await makeHoldingTransaction(tx, {
        ...base,
        counterparty: null,
        description: 'Cafe 123 Example 456',
      });
    });
    expect((await f.s.preview(f.user.id, f.scope)).matched).toBe(3);
  }));
test('disabled rules do not match and only the selected account participates', async () =>
  usingFixture(async (f) => {
    await f.s.save(f.user.id, {
      id: f.rule.id,
      expectedRevision: 1,
      accountId: f.account.id,
      categoryId: f.target,
      payeeText: 'Cafe Example',
      enabled: false,
    });
    expect((await f.s.preview(f.user.id, f.scope)).matched).toBe(0);
    const other = await getDb().transaction(async (tx) => {
      const account = await makeAccount(tx, { userId: f.user.id, institutionId: f.institution.id });
      await makeHoldingTransaction(tx, {
        userId: f.user.id,
        accountId: account.id,
        tokenId: f.token.id,
        counterparty: 'Cafe Example',
        ledgerKind: 'outflow',
        occurredAt: f.row.occurredAt,
      });
      return account;
    });
    await f.s.save(f.user.id, {
      accountId: other.id,
      categoryId: f.oldId,
      payeeText: 'Cafe Example',
      enabled: true,
    });
    const preview = await f.s.preview(f.user.id, { ...f.scope, accountId: other.id });
    expect(preview.matched).toBe(1);
    expect(preview.rows[0]?.afterCategoryId).toBe(f.oldId);
  }));
test('category move away and back changes timestamp and invalidates older undo', async () =>
  usingFixture(async (f) => {
    const preview = await f.s.preview(f.user.id, f.scope);
    await f.s.apply(f.user.id, preview.previewId);
    await getDb().transaction(async (tx) => {
      const repo = new TransactionCategoryRepository();
      await repo.moveTransactions(f.user.id, f.target, f.oldId, tx);
      await repo.moveTransactions(f.user.id, f.oldId, f.target, tx);
    });
    await expect(f.s.undo(f.user.id, preview.previewId)).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
    });
  }));

for (const [name, mutate] of [
  [
    'changed row deletion',
    (f: Fixture) => sql`delete from holding_transactions where id = ${f.row.id}`,
  ],
  [
    'later import',
    (f: Fixture) =>
      sql`update holding_transactions set category_set_by = 'import' where id = ${f.row.id}`,
  ],
  [
    'transfer pairing',
    (f: Fixture) =>
      sql`update holding_transactions set transfer_group_id = ${crypto.randomUUID()} where id = ${f.row.id}`,
  ],
  ['account deletion', (f: Fixture) => sql`delete from accounts where id = ${f.account.id}`],
] as const)
  test(`${name} refuses retained undo atomically`, async () =>
    usingFixture(async (f) => {
      const preview = await f.s.preview(f.user.id, f.scope);
      await f.s.apply(f.user.id, preview.previewId);
      await getDb().execute(mutate(f));
      await expect(f.s.undo(f.user.id, preview.previewId)).rejects.toMatchObject({
        code: 'UNDO_CONFLICT',
      });
      expect((await f.s.recent(f.user.id)).items[0]?.status).toBe('applied');
    }));
test('foreign previews and pruned/missing operations share NOT_FOUND', async () =>
  usingFixture(async (f) => {
    const foreign = await getDb().transaction((tx) => makeUser(tx));
    try {
      const preview = await f.s.preview(f.user.id, f.scope);
      await expect(f.s.apply(foreign.id, preview.previewId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(f.s.undo(foreign.id, preview.previewId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(f.s.apply(foreign.id, crypto.randomUUID())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await getDb().execute(sql`delete from users where id = ${foreign.id}`);
    }
  }));

async function waitOutcome(
  pid: number,
  completed: () => boolean
): Promise<'blocked' | 'completed'> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (completed()) return 'completed';
    const [row] = await getDb().execute(sql`select cardinality(pg_blocking_pids(${pid})) n`);
    if (Number((row as { n: number }).n) > 0) return 'blocked';
    await Bun.sleep(10);
  }
  throw new Error('Neither completion nor an actual blocking lock was observed');
}
async function ownerRunCount(userId: string): Promise<number> {
  const [row] = await getDb().execute(
    sql`select count(*)::int n from transaction_category_rule_runs where user_id = ${userId}`
  );
  return (row as { n: number }).n;
}
for (const erasureFirst of [true, false])
  test(
    `erasure and preview serialize with zero retained private runs; erasureFirst=${erasureFirst}`,
    async () =>
      usingFixture(async (f) =>
        usingFixture(async (second) => {
          const ready = deferred();
          const release = deferred();
          const contenderReady = deferred();
          const eraser = new DeleteAllUserDataUseCase();
          let firstPid = 0;
          let pid = 0;
          let contenderCompleted = false;
          let manifestStarted = false;
          const erase = (pause: boolean) =>
            getDb().transaction(async (tx) => {
              const [backend] = await tx.execute(sql`select pg_backend_pid() pid`);
              if (pause) firstPid = (backend as { pid: number }).pid;
              else {
                pid = (backend as { pid: number }).pid;
                contenderReady.resolve();
              }
              return eraser.deleteRows(
                intercepted(tx, async (query, run) => {
                  if (
                    query
                      .replaceAll('"', '')
                      .startsWith('delete from transaction_category_rule_runs')
                  ) {
                    manifestStarted = true;
                    const value = await run();
                    if (pause) {
                      ready.resolve();
                      await release.promise;
                    }
                    return value;
                  }
                  return run();
                }),
                f.user.id
              );
            });
          const preview = (pause: boolean) =>
            getDb().transaction(async (tx) => {
              const [backend] = await tx.execute(sql`select pg_backend_pid() pid`);
              if (pause) firstPid = (backend as { pid: number }).pid;
              else {
                pid = (backend as { pid: number }).pid;
                contenderReady.resolve();
              }
              return f.s.preview(
                f.user.id,
                f.scope,
                intercepted(tx, async (query, run) => {
                  const value = await run();
                  if (pause && query.includes('insert into transaction_category_rule_runs')) {
                    ready.resolve();
                    await release.promise;
                  }
                  return value;
                })
              );
            });
          const first = erasureFirst ? erase(true) : preview(true);
          await ready.promise;
          const contender = (erasureFirst ? preview(false) : erase(false)).then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          );
          void contender.then(() => {
            contenderCompleted = true;
          });
          let observed: 'blocked' | 'completed';
          let waitingQuery = '';
          let blockers: number[] = [];
          let deletionBeforeRelease = false;
          try {
            await contenderReady.promise;
            observed = await waitOutcome(pid, () => contenderCompleted);
            const [activity] = await getDb().execute(
              sql`select query, pg_blocking_pids(pid) blockers from pg_stat_activity where pid = ${pid}`
            );
            waitingQuery = (activity as { query: string }).query;
            blockers = (activity as { blockers: number[] }).blockers;
            deletionBeforeRelease = manifestStarted;
            const otherPreview = await second.s.preview(second.user.id, second.scope);
            expect(otherPreview.changed).toBe(1);
          } finally {
            release.resolve();
          }
          await first;
          const result = await contender;
          expect(await ownerRunCount(f.user.id)).toBe(0);
          expect(observed).toBe('blocked');
          expect(firstPid).toBeGreaterThan(0);
          expect(blockers).toContain(firstPid);
          expect(
            await getDb().execute(sql`select id from users where id = ${f.user.id}`)
          ).toHaveLength(1);
          expect(await f.s.list(f.user.id)).toEqual([]);
          expect(
            await getDb().execute(sql`select id from accounts where user_id = ${f.user.id}`)
          ).toHaveLength(0);
          expect(
            await getDb().execute(
              sql`select id from holding_transactions where user_id = ${f.user.id}`
            )
          ).toHaveLength(0);
          expect(waitingQuery).toContain('pg_advisory_xact_lock');
          if (erasureFirst) {
            expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
          } else {
            expect(result.ok).toBe(true);
            expect(deletionBeforeRelease).toBe(false);
          }
          expect(await ownerRunCount(second.user.id)).toBe(1);
          expect(await second.s.list(second.user.id)).toHaveLength(1);
          expect(
            await getDb().execute(sql`select id from accounts where id = ${second.account.id}`)
          ).toHaveLength(1);
          expect(
            await getDb().execute(
              sql`select id from holding_transactions where id = ${second.row.id}`
            )
          ).toHaveLength(1);
        })
      ),
    30_000
  );
