import { describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { TransactionCategoryRepository } from '../../../src/repositories/TransactionCategoryRepository';
import { TransactionCategoryRuleRepository } from '../../../src/repositories/TransactionCategoryRuleRepository';
import { TransactionCategoryRuleService } from '../../../src/services/categories/TransactionCategoryRuleService';
import { TransactionCategoryService } from '../../../src/services/categories/TransactionCategoryService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

function service() {
  Container.set(TransactionCategoryRuleRepository, new TransactionCategoryRuleRepository());
  return new TransactionCategoryRuleService();
}
async function fixture(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const owner = await makeUser(tx);
  const foreign = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: owner.id, institutionId: institution.id });
  const other = await makeAccount(tx, { userId: owner.id, institutionId: institution.id });
  const foreignAccount = await makeAccount(tx, {
    userId: foreign.id,
    institutionId: institution.id,
  });
  const categories = new TransactionCategoryRepository();
  const categoryId = await categories.insertOne({ userId: owner.id, name: 'Food' }, tx);
  const foreignCategory = await categories.insertOne({ userId: foreign.id, name: 'Food' }, tx);
  return { owner, foreign, account, other, foreignAccount, categoryId, foreignCategory };
}

describe('saved category rule definitions', () => {
  test('normalizes through SQL and same payee same account is unique even disabled', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const s = service();
      const draft = {
        accountId: f.account.id,
        categoryId: f.categoryId,
        payeeText: 'TESCO STORES Ltd',
        enabled: false,
      };
      const rule = await s.save(f.owner.id, draft, tx);
      expect(rule.payeeKey).toBe('tesco stores');
      await expect(
        s.save(f.owner.id, { ...draft, payeeText: 'Tesco Stores Limited' }, tx)
      ).rejects.toMatchObject({ code: 'DUPLICATE_RULE' });
      expect(await s.list(f.owner.id, tx)).toEqual([rule]);
      expect(await s.list(f.foreign.id, tx)).toEqual([]);
    });
  });
  test('foreign account and category are not found', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const s = service();
      const draft = {
        accountId: f.account.id,
        categoryId: f.categoryId,
        payeeText: 'Cafe Example',
        enabled: true,
      };
      await expect(
        s.save(f.owner.id, { ...draft, accountId: f.foreignAccount.id }, tx)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        s.save(f.owner.id, { ...draft, categoryId: f.foreignCategory }, tx)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        s.save(f.owner.id, { ...draft, accountId: crypto.randomUUID() }, tx)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await s.list(f.owner.id, tx)).toEqual([]);
    });
  });
  test('same payee different accounts are independent and stale revisions refuse', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const s = service();
      const draft = {
        accountId: f.account.id,
        categoryId: f.categoryId,
        payeeText: 'Cafe Example',
        enabled: true,
      };
      const a = await s.save(f.owner.id, draft, tx);
      const b = await s.save(f.owner.id, { ...draft, accountId: f.other.id }, tx);
      expect(a.id).not.toBe(b.id);
      const edited = await s.save(
        f.owner.id,
        { ...draft, id: a.id, expectedRevision: 1, enabled: false },
        tx
      );
      expect(edited.revision).toBe(2);
      await expect(
        s.save(f.owner.id, { ...draft, id: a.id, expectedRevision: 1 }, tx)
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(s.remove(f.owner.id, a.id, 1, tx)).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      await expect(s.remove(f.foreign.id, a.id, 2, tx)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await s.remove(f.owner.id, a.id, 2, tx);
      expect((await s.list(f.owner.id, tx)).map((r) => r.id)).toEqual([b.id]);
    });
  });
  test('null account, missing edit revision, empty normalized key and oversized payee refuse', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const s = service();
      const draft = {
        accountId: f.account.id,
        categoryId: f.categoryId,
        payeeText: 'Cafe Example',
        enabled: true,
      };
      for (const patch of [
        { accountId: null },
        { payeeText: '!!!' },
        { payeeText: 'x'.repeat(201) },
        { id: crypto.randomUUID() },
      ]) {
        await expect(
          s.save(f.owner.id, { ...draft, ...patch } as typeof draft, tx)
        ).rejects.toMatchObject({ code: 'INVALID_RULE' });
      }
    });
  });
  test('hundred and first rule refuses and account deletion cascades its rules', async () => {
    await withTestDb(async (tx) => {
      const f = await fixture(tx);
      const s = service();
      for (let i = 0; i < 100; i++) {
        await s.save(
          f.owner.id,
          {
            accountId: f.account.id,
            categoryId: f.categoryId,
            payeeText: `Merchant ${i} shop`,
            enabled: true,
          },
          tx
        );
      }
      await expect(
        s.save(
          f.owner.id,
          {
            accountId: f.other.id,
            categoryId: f.categoryId,
            payeeText: 'Last merchant',
            enabled: true,
          },
          tx
        )
      ).rejects.toMatchObject({ code: 'RULE_LIMIT' });
      await tx.execute(sql`delete from accounts where id = ${f.account.id}`);
      expect(await s.list(f.owner.id, tx)).toEqual([]);
    });
  });
});

describe('saved category rule operations', () => {
  async function ledgerFixture(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    const f = await fixture(tx);
    const [fiat] = await tx.execute(sql`select id from token_types where code = 'fiat'`);
    const token = await makeToken(tx, { typeId: (fiat as { id: string }).id });
    const holding = await makeHolding(tx, {
      userId: f.owner.id,
      accountId: f.account.id,
      tokenId: token.id,
    });
    const row = async (patch: Partial<Parameters<typeof makeHoldingTransaction>[1]> = {}) =>
      makeHoldingTransaction(tx, {
        userId: f.owner.id,
        holdingId: holding.id,
        counterparty: 'Cafe Example',
        kind: 'withdraw',
        ledgerKind: 'outflow',
        occurredAt: new Date('2026-11-10T12:00:00Z'),
        ...patch,
      });
    const scope = {
      accountId: f.account.id,
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
    };
    const s = service();
    const rule = await s.save(
      f.owner.id,
      {
        accountId: f.account.id,
        categoryId: f.categoryId,
        payeeText: 'Cafe Example',
        enabled: true,
      },
      tx
    );
    return { ...f, s, row, scope, rule, holding, token };
  }
  test('complete preview protects authority and apply/undo only changes reviewed categories', async () => {
    await withTestDb(async (tx) => {
      const f = await ledgerFixture(tx);
      const changed = await f.row();
      await f.row({ categoryId: f.categoryId, categorySetBy: 'person' });
      await f.row({ categoryId: f.categoryId, categorySetBy: 'import' });
      await f.row({ categorySetBy: 'cleared' });
      await f.row({ categoryId: f.categoryId, categorySetBy: 'custom_rule' });
      const provenance = await f.row({ categoryId: f.categoryId, categorySetBy: 'ai' });
      const before = await tx.execute(
        sql`select to_jsonb(h) - 'category_id' - 'category_set_by' - 'updated_at' as evidence from holding_transactions h where id = ${changed.id}`
      );
      const preview = await f.s.preview(f.owner.id, f.scope, tx);
      expect([preview.matched, preview.protected, preview.unchanged, preview.changed]).toEqual([
        6, 3, 1, 2,
      ]);
      expect(preview.rows.map((r) => r.transactionId).sort()).toEqual(
        [changed.id, provenance.id].sort()
      );
      const arriving = await f.row();
      expect(await f.s.apply(f.owner.id, preview.previewId, tx)).toEqual({
        operationId: preview.previewId,
        changed: 2,
        replayed: false,
      });
      expect(
        (
          await tx.execute(
            sql`select category_set_by from holding_transactions where id = ${arriving.id}`
          )
        )[0]
      ).toMatchObject({ category_set_by: null });
      expect(await f.s.apply(f.owner.id, preview.previewId, tx)).toMatchObject({
        changed: 2,
        replayed: true,
      });
      await f.s.remove(f.owner.id, f.rule.id, 1, tx);
      expect(await f.s.undo(f.owner.id, preview.previewId, tx)).toMatchObject({
        restored: 2,
        replayed: false,
      });
      expect(await f.s.undo(f.owner.id, preview.previewId, tx)).toMatchObject({
        restored: 2,
        replayed: true,
      });
      expect(
        await tx.execute(
          sql`select to_jsonb(h) - 'category_id' - 'category_set_by' - 'updated_at' as evidence from holding_transactions h where id = ${changed.id}`
        )
      ).toEqual(before);
      expect(
        (
          await tx.execute(
            sql`select category_id, category_set_by from holding_transactions where id = ${provenance.id}`
          )
        )[0]
      ).toMatchObject({ category_id: f.categoryId, category_set_by: 'ai' });
      await expect(f.s.apply(f.owner.id, preview.previewId, tx)).rejects.toMatchObject({
        code: 'ALREADY_UNDONE',
      });
    });
  });
  test('manual edit stales entire apply and changed row edit conflicts with whole undo', async () => {
    await withTestDb(async (tx) => {
      const f = await ledgerFixture(tx);
      const a = await f.row();
      await f.row();
      const first = await f.s.preview(f.owner.id, f.scope, tx);
      await tx.execute(
        sql`update holding_transactions set description = 'later edit' where id = ${a.id}`
      );
      await expect(f.s.apply(f.owner.id, first.previewId, tx)).rejects.toMatchObject({
        code: 'STALE_PREVIEW',
      });
      const fresh = await f.s.preview(f.owner.id, f.scope, tx);
      await f.s.apply(f.owner.id, fresh.previewId, tx);
      await tx.execute(
        sql`update holding_transactions set category_id = null, category_set_by = 'cleared', updated_at = clock_timestamp() where id = ${a.id}`
      );
      await expect(f.s.undo(f.owner.id, fresh.previewId, tx)).rejects.toMatchObject({
        code: 'UNDO_CONFLICT',
      });
    });
  });
  test('server refuses no-change apply and fourth preview without evicting receipts', async () => {
    await withTestDb(async (tx) => {
      const f = await ledgerFixture(tx);
      const first = await f.s.preview(f.owner.id, f.scope, tx);
      await expect(f.s.apply(f.owner.id, first.previewId, tx)).rejects.toMatchObject({
        code: 'NO_CHANGES',
      });
      await f.s.preview(f.owner.id, f.scope, tx);
      await f.s.preview(f.owner.id, f.scope, tx);
      await expect(f.s.preview(f.owner.id, f.scope, tx)).rejects.toMatchObject({
        code: 'PREVIEW_LIMIT',
      });
      expect(await f.s.recent(f.owner.id, tx)).toEqual({ items: [] });
    });
  });
});

test('saved rules block category removal including disabled rules', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx);
    await service().save(
      f.owner.id,
      {
        accountId: f.account.id,
        categoryId: f.categoryId,
        payeeText: 'Cafe Example',
        enabled: false,
      },
      tx
    );
    const categories = new TransactionCategoryService();
    await expect(categories.remove(f.owner.id, f.categoryId, undefined, tx)).rejects.toMatchObject({
      name: 'CategoryRuleInUseError',
      count: 1,
    });
    expect(
      await new TransactionCategoryRepository().findOwned(f.owner.id, f.categoryId, tx)
    ).toBeDefined();
  });
});

test('user deletion cascades rule definitions and receipts without touching another owner', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx);
    const s = service();
    await s.save(
      f.owner.id,
      {
        accountId: f.account.id,
        categoryId: f.categoryId,
        payeeText: 'Cafe Example',
        enabled: true,
      },
      tx
    );
    await s.save(
      f.foreign.id,
      {
        accountId: f.foreignAccount.id,
        categoryId: f.foreignCategory,
        payeeText: 'Cafe Example',
        enabled: true,
      },
      tx
    );
    const scope = {
      accountId: f.account.id,
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
    };
    await s.preview(f.owner.id, scope, tx);
    await s.preview(f.foreign.id, { ...scope, accountId: f.foreignAccount.id }, tx);
    await tx.execute(sql`delete from users where id = ${f.owner.id}`);
    expect(await s.list(f.owner.id, tx)).toEqual([]);
    expect(await s.list(f.foreign.id, tx)).toHaveLength(1);
    expect(
      (await tx.execute(sql`select user_id from transaction_category_rule_runs`)).map(
        (r: { user_id: string }) => r.user_id
      )
    ).toContain(f.foreign.id);
    expect(
      (
        await tx.execute(
          sql`select count(*)::int n from transaction_category_rule_runs where user_id = ${f.owner.id}`
        )
      )[0]
    ).toMatchObject({ n: 0 });
  });
});
