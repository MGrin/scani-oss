import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { SUGGESTED_CATEGORY_KEYS } from '@scani/shared';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { KindCategoryAssigner } from '../../../src/services/categories/KindCategoryAssigner';
import { TransactionCategoryService } from '../../../src/services/categories/TransactionCategoryService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import { makeHoldingTransaction, makeToken } from '../../../test/helpers/factories-extra';

const assigner = () => Container.get(KindCategoryAssigner);

async function typed(tx: DatabaseTransaction, code: string): Promise<string> {
  await tx.execute(
    sql`insert into token_types (code, name) values (${code}, ${code}) on conflict (code) do nothing`
  );
  const [type] = (await tx.execute(
    sql`select id from token_types where code = ${code}`
  )) as unknown as Array<{ id: string }>;
  return (await makeToken(tx, { typeId: type?.id, symbol: `T${randomUUID().slice(0, 8)}` })).id;
}

/** The four categories the product call names, as a person who uses them has them. */
async function named(tx: DatabaseTransaction, userId: string) {
  const make = async (name: string, parentId?: string) =>
    (await Container.get(TransactionCategoryService).create(userId, { name, parentId }, tx)).id;
  const fees = await make('Fees');
  return {
    bankFees: await make('Bank fees', fees),
    interest: await make('Interest'),
    dividends: await make('Dividends'),
    income: await make('Income'),
  };
}

async function row(
  tx: DatabaseTransaction,
  userId: string,
  kind: string,
  extra: {
    type?: string;
    counterparty?: string | null;
    subtype?: string | null;
    income?: string;
  } = {}
) {
  const r = await makeHoldingTransaction(tx, {
    userId,
    kind,
    counterparty: extra.counterparty ?? null,
    description: null,
    kindSubtype: extra.subtype ?? null,
    sourceMetadata: extra.income ? { income: extra.income } : undefined,
    tokenId: await typed(tx, extra.type ?? 'fiat'),
  });
  return r.id;
}

async function stateOf(tx: DatabaseTransaction, id: string) {
  const [r] = (await tx.execute(
    sql`select category_id, category_set_by from holding_transactions where id = ${id}`
  )) as unknown as Array<{ category_id: string | null; category_set_by: string | null }>;
  return [r?.category_id ?? null, r?.category_set_by ?? null];
}

/** The user's categories as `parent › child` paths, sorted. */
async function paths(tx: DatabaseTransaction, userId: string): Promise<string[]> {
  const rows =
    (await tx.execute(sql`select case when p.name is null then c.name else p.name || ' › ' || c.name end as path
    from transaction_categories c left join transaction_categories p on p.id = c.parent_id
    where c.user_id = ${userId}`)) as unknown as Array<{ path: string }>;
  return Array.from(rows, (r) => r.path).sort();
}

describe('KindCategoryAssigner (SC-1720)', () => {
  test('a row with no payee text is categorized by its type, marked kind', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const c = await named(tx, user.id);
      const fee = await row(tx, user.id, 'fee');
      const interest = await row(tx, user.id, 'interest', { subtype: 'apy' });
      const dividend = await row(tx, user.id, 'reward', {
        subtype: 'dividend',
        income: 'dividend',
      });
      const staking = await row(tx, user.id, 'reward', { type: 'crypto', subtype: 'reward' });

      expect(await assigner().apply(tx, user.id)).toBe(4);
      expect(await stateOf(tx, fee)).toEqual([c.bankFees, 'kind']);
      expect(await stateOf(tx, interest)).toEqual([c.interest, 'kind']);
      expect(await stateOf(tx, dividend)).toEqual([c.dividends, 'kind']);
      expect(await stateOf(tx, staking)).toEqual([c.income, 'kind']);
    });
  });

  test('a fee on any account is a bank fee, a crypto fee with a chain address included', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const c = await named(tx, user.id);
      const gas = await row(tx, user.id, 'fee', {
        type: 'crypto',
        counterparty: '0x1720000000000000000000000000000000000001',
      });
      const broker = await row(tx, user.id, 'fee', { type: 'stock' });
      await assigner().apply(tx, user.id);
      expect(await stateOf(tx, gas)).toEqual([c.bankFees, 'kind']);
      expect(await stateOf(tx, broker)).toEqual([c.bankFees, 'kind']);
    });
  });

  test('a bank row with payee text is left to the payee steps', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await named(tx, user.id);
      const id = await row(tx, user.id, 'fee', { counterparty: 'Monthly account fee' });
      expect(await assigner().apply(tx, user.id)).toBe(0);
      expect(await stateOf(tx, id)).toEqual([null, null]);
    });
  });

  test('trades, settlements, transfers and opening balances get no category', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await named(tx, user.id);
      const kinds = ['buy', 'sell', 'swap_in', 'settle_out', 'transfer_in', 'opening_balance'];
      const ids = await Promise.all(kinds.map((kind) => row(tx, user.id, kind)));
      const leg = await row(tx, user.id, 'fee');
      await tx.execute(
        sql`update holding_transactions set transfer_group_id = gen_random_uuid() where id = ${leg}`
      );
      expect(await assigner().apply(tx, user.id)).toBe(0);
      for (const id of [...ids, leg]) expect(await stateOf(tx, id)).toEqual([null, null]);
    });
  });

  test("a person's pick, a person's clear and an import are never written over", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const c = await named(tx, user.id);
      const picked = await row(tx, user.id, 'fee');
      const cleared = await row(tx, user.id, 'fee');
      const imported = await row(tx, user.id, 'fee');
      await tx.execute(
        sql`update holding_transactions set category_id = ${c.income}, category_set_by = 'person' where id = ${picked}`
      );
      await tx.execute(
        sql`update holding_transactions set category_set_by = 'cleared' where id = ${cleared}`
      );
      await tx.execute(
        sql`update holding_transactions set category_id = ${c.income}, category_set_by = 'import' where id = ${imported}`
      );
      expect(await assigner().apply(tx, user.id)).toBe(0);
      expect(await stateOf(tx, picked)).toEqual([c.income, 'person']);
      expect(await stateOf(tx, cleared)).toEqual([null, 'cleared']);
      expect(await stateOf(tx, imported)).toEqual([c.income, 'import']);
    });
  });

  test('a person with no categories gets the whole starter set, in their language (SC-1722)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const fee = await row(tx, user.id, 'fee');
      expect(await assigner().apply(tx, user.id)).toBe(1);
      const all = await paths(tx, user.id);
      expect(all).toHaveLength(SUGGESTED_CATEGORY_KEYS.length);
      expect(all).toContain('Food › Groceries');
      const [bankFees] = (await tx.execute(
        sql`select c.id from transaction_categories c where c.user_id = ${user.id} and c.name = 'Bank fees'`
      )) as unknown as Array<{ id: string }>;
      expect(await stateOf(tx, fee)).toEqual([bankFees?.id ?? null, 'kind']);
    });
  });

  test('a person with categories gets only the missing ones a row needs, in the starter shape (SC-1722)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await Container.get(TransactionCategoryService).create(user.id, { name: 'Pets' }, tx);
      const fee = await row(tx, user.id, 'fee');
      const interest = await row(tx, user.id, 'interest');
      expect(await assigner().apply(tx, user.id)).toBe(2);
      expect(await paths(tx, user.id)).toEqual([
        'Fees',
        'Fees › Bank fees',
        'Income',
        'Income › Interest',
        'Pets',
      ]);
      expect((await stateOf(tx, fee))[1]).toBe('kind');
      expect((await stateOf(tx, interest))[1]).toBe('kind');
    });
  });

  test("it is created in the user's language (SC-1722)", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { language: 'ru' });
      await row(tx, user.id, 'reward', { subtype: 'dividend', income: 'dividend' });
      await assigner().apply(tx, user.id);
      const all = await paths(tx, user.id);
      expect(all).toHaveLength(SUGGESTED_CATEGORY_KEYS.length);
      expect(all).toContain('Доходы › Дивиденды');
      expect(all).toContain('Еда › Продукты');
    });
  });

  test("a starter set in the user's language is matched, not duplicated (SC-1722)", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { language: 'ru' });
      const own = (
        await Container.get(TransactionCategoryService).create(
          user.id,
          { name: 'Банковские комиссии' },
          tx
        )
      ).id;
      const fee = await row(tx, user.id, 'fee');
      await assigner().apply(tx, user.id);
      expect(await stateOf(tx, fee)).toEqual([own, 'kind']);
      expect(await paths(tx, user.id)).toEqual(['Банковские комиссии']);
    });
  });

  test('a user with no row of these types gets no category (SC-1722)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await row(tx, user.id, 'buy');
      await row(tx, user.id, 'fee', { counterparty: 'Monthly account fee' });
      expect(await assigner().apply(tx, user.id)).toBe(0);
      expect(await paths(tx, user.id)).toEqual([]);
    });
  });

  test('a category is matched by name whatever its case, and only among the owner’s', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      await named(tx, other.id);
      const mine = (
        await Container.get(TransactionCategoryService).create(user.id, { name: 'BANK FEES' }, tx)
      ).id;
      const fee = await row(tx, user.id, 'fee');
      await assigner().apply(tx, user.id);
      expect(await stateOf(tx, fee)).toEqual([mine, 'kind']);
    });
  });

  test('with no user, every user is covered, and another user is not touched by a scoped run', async () => {
    await withTestDb(async (tx) => {
      const a = await makeUser(tx);
      const b = await makeUser(tx);
      const ca = await named(tx, a.id);
      const cb = await named(tx, b.id);
      const feeA = await row(tx, a.id, 'fee');
      const feeB = await row(tx, b.id, 'fee');
      await assigner().apply(tx, a.id);
      expect(await stateOf(tx, feeB)).toEqual([null, null]);
      await assigner().apply(tx);
      expect(await stateOf(tx, feeA)).toEqual([ca.bankFees, 'kind']);
      expect(await stateOf(tx, feeB)).toEqual([cb.bankFees, 'kind']);
    });
  });
});
