import { expect, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { BACKUP_UPLOAD_MAX_BYTES } from '@scani/shared';
import { and, eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { lockCategoryRuleOwner } from '../../../src/lib/category-rule-owner-lock';
import { BackupRestorer, backupRecords } from '../../../src/services/backup/BackupRestorer';
import { type BackupRecord, BackupWriter } from '../../../src/services/backup/BackupWriter';
import { UserBackupService } from '../../../src/services/backup/UserBackupService';
import { TransactionCategoryService } from '../../../src/services/categories/TransactionCategoryService';
import { DeleteAllUserDataUseCase } from '../../../src/use-cases/DeleteAllUserDataUseCase';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeUser } from '../../../test/helpers/factories';
import { makeToken } from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

const t = schema.monthlyCategoryBudgets;
const exact = '999999999999999.123456789012345678';
const month = '2026-01-01';
const db = getDb();

async function fixture() {
  return db.transaction(async (tx) => {
    const user = await makeUser(tx);
    await tx.insert(schema.tokenTypes).values({ code: 'fiat', name: 'Fiat' }).onConflictDoNothing();
    const [fiat] = await tx
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'fiat'));
    const token = await makeToken(tx, { typeId: fiat!.id });
    const [root] = await tx
      .insert(schema.transactionCategories)
      .values({ userId: user.id, name: 'Root' })
      .returning();
    const [parent] = await tx
      .insert(schema.transactionCategories)
      .values({ userId: user.id, name: 'Other' })
      .returning();
    return { userId: user.id, tokenId: token.id, categoryId: root!.id, parentId: parent!.id };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const budget = (f: Fixture, patch = {}) => ({
  userId: f.userId,
  categoryId: f.categoryId,
  tokenId: f.tokenId,
  month,
  limit: exact,
  ...patch,
});

async function drop(f: Fixture) {
  await db.transaction(async (tx) => {
    await new DeleteAllUserDataUseCase().deleteRows(tx, f.userId);
    await tx.delete(schema.users).where(eq(schema.users.id, f.userId));
    await tx.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  });
}
async function count(f: Fixture) {
  return db.select().from(t).where(eq(t.userId, f.userId));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('control barrier exceeded 5s')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function limits(tx: DatabaseTransaction) {
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}
async function blocked(pid: number) {
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    const [row] = await db.execute(sql`select pg_blocking_pids(${pid}) as blockers`);
    const blockers = row?.blockers;
    if (Array.isArray(blockers) && blockers.length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error('contender never reached a database lock');
}
async function records(userId: string) {
  const file = await new BackupWriter().file(userId);
  return Array.fromAsync(backupRecords(file.bytes));
}
const open = (rows: BackupRecord[]) =>
  async function* () {
    yield* rows;
  };

// A synthetic SQL equivalent only: compatibility A must have no application budget producer.
async function save(tx: DatabaseTransaction, f: Fixture) {
  await lockCategoryRuleOwner(tx, f.userId);
  const [root] = await tx
    .select()
    .from(schema.transactionCategories)
    .where(
      and(
        eq(schema.transactionCategories.id, f.categoryId),
        eq(schema.transactionCategories.userId, f.userId)
      )
    )
    .for('update');
  if (!root || root.parentId !== null) throw new Error('root eligibility changed');
  await tx.insert(t).values(budget(f));
}

test('populated budget export keeps exact text, owner/category/token IDs and budget-only currency catalog references; erasure keeps the other owner', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    await db.insert(t).values([budget(f), budget(other)]);
    const out = await records(f.userId);
    expect(out[0]).toMatchObject({ type: 'header', version: 4 });
    expect(
      out.filter((r) => r.type === 'row' && r.table === 'monthly_category_budgets')
    ).toMatchObject([{ row: { ...budget(f), requiresRoot: true } }]);
    expect(
      out
        .filter((r) => r.type === 'catalog' && r.table === 'tokens')
        .map((r) => r.type === 'catalog' && r.row.id)
    ).toContain(f.tokenId);
    await db.transaction((tx) => new DeleteAllUserDataUseCase().deleteRows(tx, f.userId));
    expect(await count(f)).toHaveLength(0);
    expect(await count(other)).toHaveLength(1);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, f.userId))).toHaveLength(
      1
    );
    await db.delete(schema.users).where(eq(schema.users.id, other.userId));
    expect(await count(other)).toHaveLength(0);
  } finally {
    await drop(f);
    await drop(other);
  }
});

test('budget-only table probe is nonempty and portable restore refuses the occupied target', async () => {
  const f = await fixture();
  try {
    await db.insert(t).values(budget(f, { limit: '0' }));
    // Probe the real budget table independently: categories are required FK scaffolding.
    const budgetOnly = {
      select: () => ({
        from: (table: unknown) =>
          table === t
            ? db.select({ one: sql<number>`1` }).from(t)
            : { where: () => ({ limit: async () => [] }) },
      }),
    } as unknown as ReturnType<typeof getDb>;
    expect(await new BackupRestorer().hasData(f.userId, budgetOnly)).toBe(true);
    const target = await fixture();
    try {
      const out = await records(target.userId);
      await expect(new BackupRestorer().restore(f.userId, open(out))).rejects.toMatchObject({
        reason: 'not-empty',
      });
      expect(await count(f)).toHaveLength(1);
    } finally {
      await drop(target);
    }
  } finally {
    await drop(f);
  }
});

for (const mutation of ['reparent', 'delete'] as const)
  for (const first of ['insert', 'legacy'] as const)
    for (const isolation of ['read committed', 'repeatable read'] as const) {
      test(`native root FK: ${mutation}, ${first} first, ${isolation}`, async () => {
        const f = await fixture();
        const ready = deferred();
        const release = deferred();
        const contenderReady = deferred();
        let pid = 0;
        const legacy = async (tx: DatabaseTransaction) => {
          if (mutation === 'reparent')
            await tx
              .update(schema.transactionCategories)
              .set({ parentId: f.parentId })
              .where(eq(schema.transactionCategories.id, f.categoryId));
          else
            await tx
              .delete(schema.transactionCategories)
              .where(eq(schema.transactionCategories.id, f.categoryId));
        };
        const insert = (tx: DatabaseTransaction) => tx.insert(t).values(budget(f));
        let leader: Promise<unknown> | undefined;
        let contender: Promise<{ error?: unknown }> | undefined;
        try {
          leader = db.transaction(
            async (tx) => {
              await limits(tx);
              await (first === 'insert' ? insert(tx) : legacy(tx));
              ready.resolve();
              await bounded(release.promise);
            },
            { isolationLevel: isolation }
          );
          await bounded(ready.promise);
          contender = db
            .transaction(
              async (tx) => {
                await limits(tx);
                const [row] = await tx.execute(sql`select pg_backend_pid() pid`);
                pid = row!.pid as number;
                contenderReady.resolve();
                await (first === 'insert' ? legacy(tx) : insert(tx));
              },
              { isolationLevel: isolation }
            )
            .then(
              () => ({}),
              (error: unknown) => ({ error })
            );
          await bounded(contenderReady.promise);
          await blocked(pid);
          release.resolve();
          await leader;
          const error = (await contender).error as { code?: string; cause?: { code?: string } };
          const code = error?.code ?? error?.cause?.code;
          expect(['23503', '40001']).toContain(code ?? '');
          expect(await count(f)).toHaveLength(first === 'insert' ? 1 : 0);
          const roots = await db
            .select()
            .from(schema.transactionCategories)
            .where(eq(schema.transactionCategories.id, f.categoryId));
          if (first === 'insert') expect(roots[0]?.parentId).toBeNull();
          else if (mutation === 'delete') expect(roots).toHaveLength(0);
          else expect(roots[0]?.parentId).toBe(f.parentId);
          console.info(
            JSON.stringify({
              control: 'root-fk',
              mutation,
              first,
              isolation,
              blockedPid: pid,
              rollback: true,
            })
          );
        } finally {
          release.resolve();
          await Promise.allSettled([leader, contender]);
          await drop(f);
        }
      }, 15000);
    }

for (const patch of [
  { userId: null },
  { categoryId: null },
  { tokenId: null },
  { month: null },
  { limit: null },
  { month: '2999-01-01' },
  { limit: '-1' },
  { limit: '1e3' },
  { limit: 'NaN' },
  { limit: 'Infinity' },
  { limit: '1000000000000000' },
  { limit: '1.1234567890123456789' },
  { requiresRoot: false },
  { requiresRoot: null },
  { month: '2026-01-02' },
  { month: '1899-12-01' },
  { tokenId: crypto.randomUUID() },
  { categoryId: crypto.randomUUID() },
]) {
  test(`invalid SQL budget rolls back atomically: ${JSON.stringify(patch)}`, async () => {
    const f = await fixture();
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(t).values(budget(f));
          await tx.insert(t).values(budget(f, { month: '2026-02-01', ...patch }));
        })
      ).rejects.toBeDefined();
      expect(await count(f)).toHaveLength(0);
    } finally {
      await drop(f);
    }
  });
}

test('foreign owner, non-fiat and duplicate tuple preserve all rows on refusal', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const crypto = await db.transaction((tx) => makeToken(tx));
    try {
      for (const patch of [
        { categoryId: other.categoryId },
        { tokenId: crypto.id },
        { categoryId: f.parentId, requiresRoot: false },
      ]) {
        await expect(
          db.transaction(async (tx) => {
            await tx.insert(t).values(budget(f));
            await tx.insert(t).values(budget(f, { month: '2026-02-01', ...patch }));
          })
        ).rejects.toBeDefined();
        expect(await count(f)).toHaveLength(0);
      }
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(t).values(budget(f));
          await tx.insert(t).values(budget(f));
        })
      ).rejects.toBeDefined();
      expect(await count(f)).toHaveLength(0);
    } finally {
      await db.delete(schema.tokens).where(eq(schema.tokens.id, crypto.id));
    }
  } finally {
    await drop(f);
    await drop(other);
  }
});

for (const { first, peer } of [
  { first: 'restore', peer: 'erase' },
  { first: 'erase', peer: 'restore' },
  { first: 'restore', peer: 'save' },
  { first: 'save', peer: 'restore' },
] as const) {
  test(`owner-before-user ${first} first versus ${peer}`, async () => {
    const source = await fixture();
    const target = await fixture();
    // Start with a genuinely empty target. Source categories provide nonempty portable data.
    await db
      .delete(schema.transactionCategories)
      .where(eq(schema.transactionCategories.userId, target.userId));
    const out = await records(source.userId);
    const ready = deferred();
    const release = deferred();
    const contenderReady = deferred();
    let pid = 0;
    let restoredRoot = '';
    const restore = async (tx: DatabaseTransaction) => {
      const result = await new BackupRestorer().restore(target.userId, open(out), tx);
      restoredRoot = result.ids.get(source.categoryId)!;
    };
    const erase = async (tx: DatabaseTransaction) => {
      await new DeleteAllUserDataUseCase().deleteRows(tx, target.userId);
      await tx.delete(schema.users).where(eq(schema.users.id, target.userId));
    };
    const syntheticSave = async (tx: DatabaseTransaction) => {
      await lockCategoryRuleOwner(tx, target.userId);
      if (first === 'save')
        await tx
          .insert(schema.transactionCategories)
          .values({ id: target.categoryId, userId: target.userId, name: 'Saved root' });
      await save(tx, {
        ...target,
        categoryId: first === 'save' ? target.categoryId : restoredRoot,
      });
    };
    let leader: Promise<unknown> | undefined;
    let contender: Promise<{ error?: unknown }> | undefined;
    try {
      leader = db.transaction(async (tx) => {
        await limits(tx);
        await lockCategoryRuleOwner(tx, target.userId);
        await (first === 'erase' ? erase(tx) : first === 'save' ? syntheticSave(tx) : restore(tx));
        ready.resolve();
        await bounded(release.promise);
      });
      await bounded(ready.promise);
      contender = db
        .transaction(async (tx) => {
          await limits(tx);
          const [row] = await tx.execute(sql`select pg_backend_pid() pid`);
          pid = row!.pid as number;
          contenderReady.resolve();
          await lockCategoryRuleOwner(tx, target.userId);
          await (peer === 'erase' ? erase(tx) : peer === 'save' ? syntheticSave(tx) : restore(tx));
        })
        .then(
          () => ({}),
          (error: unknown) => ({ error })
        );
      await bounded(contenderReady.promise);
      await blocked(pid);
      const [activity] = await db.execute(
        sql`select query from pg_stat_activity where pid = ${pid}`
      );
      expect(activity?.query).toContain('pg_advisory_xact_lock');
      release.resolve();
      await leader;
      const result = await contender;
      if (first === 'restore') {
        expect(result.error).toBeUndefined();
        expect(await count(target)).toHaveLength(peer === 'save' ? 1 : 0);
      } else if (first === 'erase') expect(result.error).toMatchObject({ reason: 'no-such-user' });
      else {
        expect(result.error).toMatchObject({ reason: 'not-empty' });
        expect(await count(target)).toHaveLength(1);
      }
      console.info(
        JSON.stringify({
          control: 'owner-first-restore',
          first,
          peer,
          blockedPid: pid,
          rollback: true,
        })
      );
    } finally {
      release.resolve();
      await Promise.allSettled([leader, contender]);
      await drop(source);
      await drop(target);
    }
  }, 15000);
}

test('one read-only repeatable-read snapshot exports the original budget and catalog during a concurrent edit', async () => {
  const f = await fixture();
  const other = await fixture();
  let pid = 0;
  let edited = false;
  class SnapshotWriter extends BackupWriter {
    override async *records(userId: string, tx: DatabaseTransaction) {
      const [settings] = await tx.execute(
        sql`select pg_backend_pid() pid, current_setting('transaction_isolation') isolation, current_setting('transaction_read_only') readonly`
      );
      pid = settings!.pid as number;
      expect(settings).toMatchObject({ isolation: 'repeatable read', readonly: 'on' });
      for await (const record of super.records(userId, tx, 1)) {
        yield record;
        if (!edited && record.type === 'catalog' && record.table === 'tokens') {
          edited = true;
          await db
            .update(t)
            .set({ tokenId: other.tokenId, limit: '0' })
            .where(eq(t.userId, f.userId));
        }
      }
    }
  }
  try {
    await db.insert(t).values(budget(f));
    const file = await new SnapshotWriter().file(f.userId);
    const out = await Array.fromAsync(backupRecords(file.bytes));
    expect(edited).toBe(true);
    expect(
      out.filter((r) => r.type === 'row' && r.table === 'monthly_category_budgets')
    ).toMatchObject([{ row: { tokenId: f.tokenId, limit: exact } }]);
    expect((await count(f))[0]).toMatchObject({ tokenId: other.tokenId, limit: '0' });
    const [activity] = await db.execute(
      sql`select state, backend_xmin from pg_stat_activity where pid = ${pid}`
    );
    expect(activity?.state).not.toBe('idle in transaction');
    expect(activity?.backend_xmin).toBeNull();
  } finally {
    await drop(f);
    await drop(other);
  }
});

for (const cancelled of [false, true]) {
  test(`snapshot and gzip release on ${cancelled ? 'cancellation' : 'failure'}`, async () => {
    const f = await fixture();
    let pid = 0;
    class FailingWriter extends BackupWriter {
      override async *records(
        _userId: string,
        tx: DatabaseTransaction
      ): AsyncGenerator<BackupRecord> {
        const [row] = await tx.execute(sql`select pg_backend_pid() pid`);
        pid = row!.pid as number;
        yield {
          type: 'header',
          format: 'scani-backup',
          version: 4,
          exportedAt: new Date().toISOString(),
          notIncluded: [],
        };
        throw new DOMException(
          'injected export failure',
          cancelled ? 'AbortError' : 'OperationError'
        );
      }
    }
    try {
      await expect(new FailingWriter().file(f.userId)).rejects.toMatchObject({
        name: cancelled ? 'AbortError' : 'OperationError',
      });
      const [activity] = await db.execute(
        sql`select state, backend_xmin from pg_stat_activity where pid = ${pid}`
      );
      expect(activity?.state).not.toBe('idle in transaction');
      expect(activity?.backend_xmin).toBeNull();
      expect(await new BackupWriter().file(f.userId)).toBeDefined();
    } finally {
      await drop(f);
    }
  });
}

for (const version of [1, 2, 3]) {
  test(`explicit legacy format${version} fixture restores without fabricated budgets; generated root is recomputed`, async () => {
    const f = await fixture();
    const sourceUser = crypto.randomUUID();
    const categoryId = crypto.randomUUID();
    const legacy: BackupRecord[] = [
      {
        type: 'header',
        format: 'scani-backup',
        version,
        exportedAt: '2026-11-25T00:00:00Z',
        notIncluded: [],
      },
      {
        type: 'row',
        table: 'transaction_categories',
        row: {
          id: categoryId,
          userId: sourceUser,
          parentId: null,
          name: 'Legacy category',
          budgetRoot: false,
        },
      },
      { type: 'end', records: 3, counts: { transaction_categories: 1 } },
    ];
    try {
      await db
        .delete(schema.transactionCategories)
        .where(eq(schema.transactionCategories.userId, f.userId));
      const result = await new BackupRestorer().restore(f.userId, open(legacy));
      const [category] = await db
        .select()
        .from(schema.transactionCategories)
        .where(eq(schema.transactionCategories.id, result.ids.get(categoryId)!));
      expect(category?.budgetRoot).toBe(true);
      expect(await count(f)).toHaveLength(0);
    } finally {
      await drop(f);
    }
  });
}

for (const bad of [
  { userId: crypto.randomUUID() },
  { categoryId: crypto.randomUUID() },
  { requiresRoot: false },
  { tokenId: crypto.randomUUID() },
  { limit: '-1' },
  { limit: 'NaN' },
  { limit: '1e3' },
  { limit: '1000000000000000' },
  { limit: '0.1234567890123456789' },
  { month: '1899-12-01' },
  { month: '2999-01-01' },
  { collision: true },
]) {
  test(`A budget-bearing restore refuses before catalog/target writes: ${JSON.stringify(bad)}`, async () => {
    const f = await fixture();
    const target = await fixture();
    try {
      const before = await db
        .select()
        .from(schema.transactionCategories)
        .where(eq(schema.transactionCategories.userId, target.userId));
      const [catalogBefore] = await db.execute(sql`select count(*)::int n from tokens`);
      const data: BackupRecord[] = [
        {
          type: 'header',
          format: 'scani-backup',
          version: 4,
          exportedAt: '2026-11-25T00:00:00Z',
          notIncluded: [],
        },
        {
          type: 'catalog',
          table: 'token_types',
          row: { id: crypto.randomUUID(), code: 'nonexistent-sentinel-before-write' },
        },
        {
          type: 'row',
          table: 'monthly_category_budgets',
          row: { id: crypto.randomUUID(), ...budget(f), ...bad },
        },
        {
          type: 'row',
          table: 'monthly_category_budgets',
          row: { id: crypto.randomUUID(), ...budget(f), ...bad },
        },
        {
          type: 'end',
          records: 5,
          counts: { 'catalog:token_types': 1, monthly_category_budgets: 2 },
        },
      ];
      await expect(new BackupRestorer().restore(target.userId, open(data))).rejects.toMatchObject({
        reason: 'budgets-not-supported',
      });
      expect(
        await db
          .select()
          .from(schema.transactionCategories)
          .where(eq(schema.transactionCategories.userId, target.userId))
      ).toEqual(before);
      expect(await count(target)).toHaveLength(0);
      const [catalogAfter] = await db.execute(sql`select count(*)::int n from tokens`);
      expect(catalogAfter?.n).toBe(catalogBefore?.n);
    } finally {
      await drop(f);
      await drop(target);
    }
  });
}

test('fallback export owns two independent read-only snapshots and releases both before metadata publication', async () => {
  const f = await fixture();
  const writerBefore = Container.get(BackupWriter);
  const storageBefore = Container.get(StorageFacade);
  const pids: number[] = [];
  let exports = 0;
  let published = false;
  async function released() {
    for (const pid of pids) {
      const [activity] = await db.execute(
        sql`select state,case when pid = pg_backend_pid() then null else backend_xmin end backend_xmin from pg_stat_activity where pid = ${pid}`
      );
      expect(activity?.state).not.toBe('idle in transaction');
      expect(activity?.backend_xmin).toBeNull();
    }
  }
  class ObservedWriter extends BackupWriter {
    override async *records(
      userId: string,
      tx: DatabaseTransaction,
      page?: number,
      files?: Parameters<BackupWriter['records']>[3]
    ) {
      const [settings] = await tx.execute(
        sql`select pg_backend_pid() pid,current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') readonly`
      );
      expect(settings).toMatchObject({ isolation: 'repeatable read', readonly: 'on' });
      pids.push(settings!.pid as number);
      yield* super.records(userId, tx, page, files);
    }
    override async file(...args: Parameters<BackupWriter['file']>) {
      // The recursive supplied-transaction call belongs to super.file's owned snapshot.
      const file = await super.file(...args);
      if (args[1]) return file;
      await released();
      exports++;
      return exports === 1
        ? {
            ...file,
            bytes: { byteLength: BACKUP_UPLOAD_MAX_BYTES + 1 } as Uint8Array<ArrayBuffer>,
            filesIncluded: 1,
          }
        : file;
    }
  }
  try {
    await db.insert(t).values(budget(f));
    Container.set(BackupWriter, new ObservedWriter());
    Container.set(StorageFacade, {
      exists: async () => false,
      read: async () => {
        throw new Error('no stored documents');
      },
      writeTemp: async () => {
        await released();
        published = true;
        return `temp/backup/${f.userId}/synthetic.gz`;
      },
      delete: async () => {},
    } as unknown as StorageFacade);
    const file = await new UserBackupService().create(f.userId);
    expect(exports).toBe(2);
    expect(pids).toHaveLength(2);
    expect(published).toBe(true);
    expect(file).toMatchObject({ formatVersion: 4, counts: { monthly_category_budgets: 1 } });
    expect(await count(f)).toHaveLength(1);
  } finally {
    Container.set(BackupWriter, writerBefore);
    Container.set(StorageFacade, storageBefore);
    await drop(f);
  }
});

for (const peer of ['erase', 'save'] as const) {
  test(`service-owned restore waits on owner before target-user locks: ${peer} first`, async () => {
    const source = await fixture();
    const target = await fixture();
    await db
      .delete(schema.transactionCategories)
      .where(eq(schema.transactionCategories.userId, target.userId));
    const out = await records(source.userId);
    const ready = deferred();
    const release = deferred();
    let firstPid = 0;
    let leader: Promise<unknown> | undefined;
    let contender: Promise<{ error?: unknown }> | undefined;
    try {
      leader = db.transaction(async (tx) => {
        await limits(tx);
        const [backend] = await tx.execute(sql`select pg_backend_pid() pid`);
        firstPid = backend!.pid as number;
        await lockCategoryRuleOwner(tx, target.userId);
        if (peer === 'erase') {
          await new DeleteAllUserDataUseCase().deleteRows(tx, target.userId);
          await tx.delete(schema.users).where(eq(schema.users.id, target.userId));
        } else {
          await tx
            .insert(schema.transactionCategories)
            .values({ id: target.categoryId, userId: target.userId, name: 'Committed by save' });
          await save(tx, target);
        }
        ready.resolve();
        await bounded(release.promise);
      });
      await bounded(ready.promise);
      contender = new BackupRestorer().restore(target.userId, open(out)).then(
        () => ({}),
        (error: unknown) => ({ error })
      );
      const end = Date.now() + 1500;
      let waiting: { pid: number; query: string } | undefined;
      while (Date.now() < end) {
        const rows = await db.execute(
          sql`select pid,query from pg_stat_activity where datname = current_database() and ${firstPid} = any(pg_blocking_pids(pid))`
        );
        waiting = rows[0] as typeof waiting;
        if (waiting) break;
        await Bun.sleep(10);
      }
      expect(waiting?.query).toContain('pg_advisory_xact_lock');
      release.resolve();
      await leader;
      expect((await contender).error).toMatchObject({
        reason: peer === 'erase' ? 'no-such-user' : 'not-empty',
      });
      expect(await count(target)).toHaveLength(peer === 'save' ? 1 : 0);
      console.info(
        JSON.stringify({
          control: 'service-owned-restore',
          peer,
          firstPid,
          waitingPid: waiting?.pid,
          waitingQuery: waiting?.query,
          rollback: true,
        })
      );
    } finally {
      release.resolve();
      await Promise.allSettled([leader, contender]);
      await drop(source);
      await drop(target);
    }
  }, 15000);
}

test('every budget update revalidates current fiat eligibility, including amount-only SQL', async () => {
  const f = await fixture();
  try {
    await db.insert(t).values(budget(f));
    const [cryptoType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'));
    expect(cryptoType).toBeDefined();
    await db
      .update(schema.tokens)
      .set({ typeId: cryptoType!.id })
      .where(eq(schema.tokens.id, f.tokenId));
    await expect(
      db.update(t).set({ limit: '1' }).where(eq(t.userId, f.userId)).execute()
    ).rejects.toBeDefined();
    expect((await count(f))[0]?.limit).toBe(exact);
  } finally {
    await drop(f);
  }
});

test('A refuses a portable token-remap collision atomically before resolving the catalog', async () => {
  const f = await fixture();
  const target = await fixture();
  try {
    await db.insert(t).values(budget(f));
    await db
      .delete(schema.transactionCategories)
      .where(eq(schema.transactionCategories.userId, target.userId));
    const out = await records(f.userId);
    const token = out.find(
      (r) => r.type === 'catalog' && r.table === 'tokens' && r.row.id === f.tokenId
    );
    const row = out.find((r) => r.type === 'row' && r.table === 'monthly_category_budgets');
    if (!token || token.type !== 'catalog' || !row || row.type !== 'row')
      throw new Error('populated export fixture missing');
    const alias = crypto.randomUUID();
    out.splice(out.indexOf(token) + 1, 0, { ...token, row: { ...token.row, id: alias } });
    out.splice(out.indexOf(row) + 1, 0, {
      ...row,
      row: { ...row.row, id: crypto.randomUUID(), tokenId: alias },
    });
    const end = out.at(-1);
    if (!end || end.type !== 'end') throw new Error('end record missing');
    end.records += 2;
    end.counts['catalog:tokens']!++;
    end.counts.monthly_category_budgets!++;
    await expect(new BackupRestorer().restore(target.userId, open(out))).rejects.toMatchObject({
      reason: 'budgets-not-supported',
    });
    expect(await new BackupRestorer().hasData(target.userId)).toBe(false);
    expect(await count(f)).toHaveLength(1);
    expect((await count(f))[0]?.limit).toBe(exact);
  } finally {
    await drop(f);
    await drop(target);
  }
});

test('inactive fiat stays in populated budget exports without changing token identity or exact text', async () => {
  const f = await fixture();
  try {
    await db.insert(t).values(budget(f));
    await db.update(schema.tokens).set({ isActive: false }).where(eq(schema.tokens.id, f.tokenId));
    const out = await records(f.userId);
    expect(out.filter((r) => r.type === 'catalog' && r.table === 'tokens')).toMatchObject([
      { row: { id: f.tokenId, isActive: false } },
    ]);
    expect(
      out.filter((r) => r.type === 'row' && r.table === 'monthly_category_budgets')
    ).toMatchObject([{ row: { tokenId: f.tokenId, limit: exact } }]);
  } finally {
    await drop(f);
  }
});

test('category update revalidates a proposed parent after a legacy reparent releases its row lock', async () => {
  const f = await fixture();
  const [third] = await db
    .insert(schema.transactionCategories)
    .values({ userId: f.userId, name: 'Third root' })
    .returning();
  const ready = deferred();
  const release = deferred();
  let firstPid = 0;
  let leader: Promise<unknown> | undefined;
  let contender: Promise<{ error?: unknown }> | undefined;
  try {
    leader = db.transaction(async (tx) => {
      await limits(tx);
      const [row] = await tx.execute(sql`select pg_backend_pid() pid`);
      firstPid = row!.pid as number;
      await tx
        .update(schema.transactionCategories)
        .set({ parentId: third!.id })
        .where(eq(schema.transactionCategories.id, f.parentId));
      ready.resolve();
      await bounded(release.promise);
    });
    await bounded(ready.promise);
    contender = new TransactionCategoryService()
      .update(f.userId, f.categoryId, { parentId: f.parentId })
      .then(
        () => ({}),
        (error: unknown) => ({ error })
      );
    let waited = false;
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      const rows = await db.execute(
        sql`select query from pg_stat_activity where datname = current_database() and ${firstPid} = any(pg_blocking_pids(pid))`
      );
      if (rows.length) {
        expect(rows[0]!.query).toContain('for update');
        waited = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waited).toBe(true);
    release.resolve();
    await leader;
    expect((await contender).error).toMatchObject({ name: 'CategoryDepthError' });
    const [root] = await db
      .select()
      .from(schema.transactionCategories)
      .where(eq(schema.transactionCategories.id, f.categoryId));
    expect(root?.parentId).toBeNull();
    expect(await count(f)).toHaveLength(0);
    console.info(
      JSON.stringify({
        control: 'fresh-category-parent',
        firstPid,
        blocked: waited,
        rollback: true,
      })
    );
  } finally {
    release.resolve();
    await Promise.allSettled([leader, contender]);
    await drop(f);
  }
});
