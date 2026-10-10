import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import type { BudgetAppAccount, BudgetAppRow } from '@scani/file-import';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  BudgetAppImportRefused,
  type BudgetAppImportRequest,
  BudgetAppImportService,
} from '../../../src/services/imports/BudgetAppImportService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeToken } from '../../../test/helpers/factories-extra';

const service = () => Container.get(BudgetAppImportService);

function row(over: Partial<BudgetAppRow>): BudgetAppRow {
  return {
    date: new Date('2026-08-14T00:00:00Z'),
    amount: '-10',
    payee: 'Shop',
    memo: null,
    category: 'Everyday: Food',
    cleared: 'Cleared',
    flag: null,
    transferAccount: null,
    line: 2,
    ...over,
  };
}

/** Checking pays 100 in, spends 10, and moves 30 to Savings, which shows the 30 arriving. */
const REGISTER: BudgetAppAccount[] = [
  {
    name: 'Checking',
    rows: [
      row({ amount: '100', payee: 'Employer', date: new Date('2026-08-01T00:00:00Z'), line: 2 }),
      row({ amount: '-10', line: 3 }),
      row({ amount: '-30', payee: 'Transfer : Savings', transferAccount: 'Savings', line: 4 }),
    ],
  },
  {
    name: 'Savings',
    rows: [
      row({ amount: '30', payee: 'Transfer : Checking', transferAccount: 'Checking', line: 5 }),
    ],
  },
];

async function owner(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const currency = await makeToken(tx, {
    symbol: `C${randomUUID().replace(/-/g, '').toUpperCase()}`,
  });
  return { userId: user.id, currency: currency.symbol };
}

function request(
  userId: string,
  currency: string,
  accounts: BudgetAppImportRequest['accounts'] = [
    { name: 'Checking', target: { kind: 'new', typeCode: 'checking' } },
    { name: 'Savings', target: { kind: 'new', typeCode: 'savings' } },
  ]
): BudgetAppImportRequest {
  return {
    userId,
    app: 'ynab',
    uploadRef: `temp/file-import/${userId}/${randomUUID()}.csv`,
    fetchedAt: new Date('2026-10-09T12:00:00Z'),
    currency,
    accounts,
    skippedRows: [{ line: 9, reason: 'zero-amount' }],
  };
}

async function balances(tx: DatabaseTransaction, userId: string) {
  const rows = await tx
    .select({ name: schema.accounts.name, balance: schema.holdings.balance })
    .from(schema.holdings)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
    .where(eq(schema.holdings.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.name, r.balance]));
}

describe('BudgetAppImportService.importRegister', () => {
  test('creates each account under the app, books its rows, and pairs the transfer in the file', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);

      const outcome = await service().importRegister(request(userId, currency), REGISTER, tx);

      expect(await balances(tx, userId)).toEqual({ Checking: '60', Savings: '30' });
      const accounts = await tx
        .select({ name: schema.accounts.name, institution: schema.institutions.name })
        .from(schema.accounts)
        .innerJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
        .where(eq(schema.accounts.userId, userId));
      expect(accounts.map((a) => a.institution)).toEqual(['YNAB', 'YNAB']);

      const legs = await tx
        .select({
          group: schema.holdingTransactions.transferGroupId,
          review: schema.holdingTransactions.transferReview,
        })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            inArray(schema.holdingTransactions.quantity, ['-30', '30'])
          )
        );
      expect(legs).toHaveLength(2);
      expect(legs[0]!.group).not.toBeNull();
      expect(legs[1]!.group).toBe(legs[0]!.group);

      expect(outcome.summary).toMatchObject({
        transfersPaired: 1,
        transfersUnpaired: 0,
        budgetsDropped: true,
        skippedRows: [{ line: 9, reason: 'zero-amount' }],
      });
      expect(outcome.summary.accounts.map((a) => [a.name, a.created, a.rowsInserted])).toEqual([
        ['Checking', true, 3],
        ['Savings', true, 1],
      ]);
      const entries = await tx
        .select()
        .from(schema.budgetAppImportEntries)
        .where(eq(schema.budgetAppImportEntries.importId, outcome.importId));
      expect(entries).toHaveLength(4);
    });
  });

  test('the same file again writes nothing new, opens no account and links no pair twice', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      await service().importRegister(request(userId, currency), REGISTER, tx);

      const again = await service().importRegister(request(userId, currency), REGISTER, tx);

      expect(await balances(tx, userId)).toEqual({ Checking: '60', Savings: '30' });
      expect(again.summary.accounts.map((a) => [a.created, a.rowsInserted])).toEqual([
        [false, 0],
        [false, 0],
      ]);
      expect(again.summary.transfersPaired).toBe(1);
    });
  });

  test('a transfer whose other account is skipped stays an ordinary row', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);

      const outcome = await service().importRegister(
        request(userId, currency, [
          { name: 'Checking', target: { kind: 'new', typeCode: 'checking' } },
          { name: 'Savings', target: { kind: 'skip' } },
        ]),
        REGISTER,
        tx
      );

      expect(await balances(tx, userId)).toEqual({ Checking: '60' });
      expect(outcome.summary).toMatchObject({ transfersPaired: 0, transfersUnpaired: 1 });
    });
  });

  test('refuses an account a provider feeds, and writes nothing', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      const institution = await makeInstitution(tx);
      const fed = await makeAccount(tx, { userId, institutionId: institution.id });
      await tx.insert(schema.feedInputs).values({
        userId,
        accountId: fed.id,
        source: 'provider:wise',
        status: 'active',
      });

      const refused = await service()
        .importRegister(
          request(userId, currency, [
            { name: 'Checking', target: { kind: 'existing', accountId: fed.id } },
          ]),
          REGISTER,
          tx
        )
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(BudgetAppImportRefused);
      expect((refused as BudgetAppImportRefused).reason).toBe('provider-fed');
      expect(await balances(tx, userId)).toEqual({});
    });
  });

  test('refuses a currency the catalog does not hold', async () => {
    await withTestDb(async (tx) => {
      const { userId } = await owner(tx);
      const refused = await service()
        .importRegister(request(userId, `ZZ${randomUUID().slice(0, 8)}`), REGISTER, tx)
        .catch((error: unknown) => error);
      expect((refused as BudgetAppImportRefused).reason).toBe('unknown-currency');
    });
  });
});

describe('BudgetAppImportService categories (SC-1652)', () => {
  async function pathsOf(tx: DatabaseTransaction, userId: string) {
    const rows = (await tx.execute(sql`
      select coalesce(p.name || ' › ' || c.name, c.name) as path, h.category_set_by as by
      from holding_transactions h
      left join transaction_categories c on c.id = h.category_id
      left join transaction_categories p on p.id = c.parent_id
      where h.user_id = ${userId}`)) as unknown as Array<{
      path: string | null;
      by: string | null;
    }>;
    return rows;
  }

  test("each row arrives in the app's category, created once", async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      await service().importRegister(request(userId, currency), REGISTER, tx);
      const paths = await pathsOf(tx, userId);
      expect(paths).toHaveLength(4);
      expect(paths.every((p) => p.path === 'Everyday › Food' && p.by === 'import')).toBe(true);
      const [count] = (await tx.execute(
        sql`select count(*)::int as n from transaction_categories where user_id = ${userId}`
      )) as unknown as Array<{ n: number }>;
      expect(count?.n).toBe(2);
    });
  });

  test('the same file again keeps a category the person chose', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      await service().importRegister(request(userId, currency), REGISTER, tx);
      const [mine] = (await tx.execute(sql`
        insert into transaction_categories (user_id, name) values (${userId}, 'Salary') returning id`)) as unknown as Array<{
        id: string;
      }>;
      await tx.execute(sql`
        update holding_transactions set category_id = ${mine!.id}, category_set_by = 'person'
        where user_id = ${userId} and quantity = '100'`);
      await service().importRegister(
        {
          ...request(userId, currency),
          uploadRef: `temp/file-import/${userId}/${randomUUID()}.csv`,
        },
        REGISTER,
        tx
      );
      const paths = (await pathsOf(tx, userId)).map((p) => p.path).sort();
      expect(paths).toEqual(['Everyday › Food', 'Everyday › Food', 'Everyday › Food', 'Salary']);
    });
  });
});

describe('BudgetAppImportService.undo', () => {
  test('removes what the upload added, and the accounts it opened', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      const { importId } = await service().importRegister(request(userId, currency), REGISTER, tx);

      const undone = await service().undo(userId, importId, tx);

      expect(undone).toMatchObject({ rowsRemoved: 4, accountsRemoved: 2, accountsKept: 0 });
      expect(await balances(tx, userId)).toEqual({});
      const windows = await tx
        .select()
        .from(schema.feedInputWindows)
        .innerJoin(schema.feedInputs, eq(schema.feedInputs.id, schema.feedInputWindows.inputId))
        .where(eq(schema.feedInputs.userId, userId));
      expect(windows).toEqual([]);
      expect(await service().undo(userId, importId, tx)).toBeNull();
    });
  });

  test('keeps an opened account the person has written to since, at what they wrote', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      const { importId } = await service().importRegister(request(userId, currency), REGISTER, tx);
      const [checking] = await tx
        .select({ holdingId: schema.holdings.id, tokenId: schema.holdings.tokenId })
        .from(schema.holdings)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
        .where(and(eq(schema.holdings.userId, userId), eq(schema.accounts.name, 'Checking')));
      await tx.insert(schema.holdingTransactions).values({
        userId,
        holdingId: checking!.holdingId,
        tokenId: checking!.tokenId,
        kind: 'deposit',
        quantity: '5',
        occurredAt: new Date('2026-09-01T00:00:00Z'),
        source: 'user-entered',
        externalId: 'by-hand',
      });

      const undone = await service().undo(userId, importId, tx);

      expect(undone).toMatchObject({ rowsRemoved: 4, accountsRemoved: 1, accountsKept: 1 });
      expect(await balances(tx, userId)).toEqual({ Checking: '5' });
    });
  });

  test("never undoes another person's upload", async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      const { importId } = await service().importRegister(request(userId, currency), REGISTER, tx);
      const stranger = await makeUser(tx);

      expect(await service().undo(stranger.id, importId, tx)).toBeNull();
      expect(await balances(tx, userId)).toEqual({ Checking: '60', Savings: '30' });
    });
  });
});

describe('BudgetAppImportService targets and list', () => {
  test('an account a provider feeds is not a target; a plain one is', async () => {
    await withTestDb(async (tx) => {
      const { userId } = await owner(tx);
      const institution = await makeInstitution(tx);
      const fed = await makeAccount(tx, { userId, institutionId: institution.id });
      const plain = await makeAccount(tx, { userId, institutionId: institution.id });
      await tx.insert(schema.feedInputs).values({
        userId,
        accountId: fed.id,
        source: 'provider:wise',
        status: 'active',
      });

      const targets = await service().importTargets(userId, tx);

      const eligible = Object.fromEntries(targets.map((t) => [t.id, t.eligible]));
      expect(eligible).toEqual({ [fed.id]: false, [plain.id]: true });
    });
  });

  test('lists the person’s uploads newest first, and an undone one says so', async () => {
    await withTestDb(async (tx) => {
      const { userId, currency } = await owner(tx);
      const first = await service().importRegister(request(userId, currency), REGISTER, tx);
      await service().undo(userId, first.importId, tx);
      const { userId: other, currency: otherCurrency } = await owner(tx);
      await service().importRegister(request(other, otherCurrency), REGISTER, tx);

      const listed = await service().listImports(userId, tx);

      expect(listed.map((r) => [r.id, r.undoneAt !== null])).toEqual([[first.importId, true]]);
      expect(listed[0]!.summary.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings']);
    });
  });
});
