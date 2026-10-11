import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq, sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';

// SC-1640: an account type carries a class, and the four liability types are
// seeded so the institution and account pickers offer them with no UI change.

describe('liability account types', () => {
  test('the four liability types are seeded and every older type stays an asset', async () => {
    await withTestDb(async (tx) => {
      const liabilities = await tx
        .select({ code: schema.accountTypes.code })
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.class, 'liability'))
        .orderBy(schema.accountTypes.code);
      expect(liabilities.map((r) => r.code)).toEqual([
        'credit_card',
        'loan',
        'mortgage',
        'other_liability',
      ]);
      const [checking] = await tx
        .select({ class: schema.accountTypes.class })
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.code, 'checking'));
      expect(checking?.class).toBe('asset');
    });
  });

  test('a class outside asset and liability is refused', async () => {
    await withTestDb(async (tx) => {
      const insert = async () => {
        await tx.execute(
          sql`insert into account_types (code, name, class) values ('zz', 'Zz', 'equity')`
        );
      };
      await expect(insert()).rejects.toThrow();
    });
  });
});

describe('liability_terms', () => {
  const mortgageType = async (tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) => {
    const [row] = await tx
      .select({ id: schema.accountTypes.id })
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'mortgage'));
    if (!row) throw new Error('mortgage type not seeded');
    return row.id;
  };

  test('a kind outside loan, credit_card and other is refused', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        typeId: await mortgageType(tx),
      });
      const insert = async () => {
        await tx
          .insert(schema.liabilityTerms)
          .values({ accountId: account.id, kind: 'mortgage' as never });
      };
      await expect(insert()).rejects.toThrow();
    });
  });

  test('deleting the account deletes its terms', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        typeId: await mortgageType(tx),
      });
      await tx.insert(schema.liabilityTerms).values({
        accountId: account.id,
        kind: 'loan',
        annualRatePct: '3.5',
        termMonths: 360,
        startDate: '2026-01-15',
        originalPrincipal: '500000',
      });
      await tx.delete(schema.accounts).where(eq(schema.accounts.id, account.id));
      const left = await tx
        .select()
        .from(schema.liabilityTerms)
        .where(eq(schema.liabilityTerms.accountId, account.id));
      expect(left).toHaveLength(0);
    });
  });
});
