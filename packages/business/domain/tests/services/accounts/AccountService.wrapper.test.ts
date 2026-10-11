import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  AccountClassChange,
  AccountService,
  UnknownWrapper,
  WrapperOnLiabilityAccount,
} from '../../../src/services/accounts/AccountService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount } from '../../../test/helpers/factories-extra';

// SC-1645: a wrapper lives on an asset account (crypto included, ruling Q3),
// and a type change never crosses between asset and liability (ruling Q4).

const service = () => Container.get(AccountService);

async function typeId(tx: DatabaseTransaction, code: string): Promise<string> {
  const [row] = await tx
    .select({ id: schema.accountTypes.id })
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, code));
  if (!row) throw new Error(`account type ${code} not seeded`);
  return row.id;
}

async function setup(tx: DatabaseTransaction, accountType: string) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, {
    userId: user.id,
    institutionId: institution.id,
    typeId: await typeId(tx, accountType),
  });
  return { user, account, institution };
}

describe('AccountService wrapper', () => {
  test('sets and clears a wrapper on an investment account', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'investment');
      expect(
        (await service().updateAccount(account.id, { wrapper: 'isa' }, user.id, tx)).wrapper
      ).toBe('isa');
      expect(
        (await service().updateAccount(account.id, { wrapper: null }, user.id, tx)).wrapper
      ).toBeNull();
    });
  });

  test('a crypto account takes a wrapper too', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'crypto');
      const saved = await service().updateAccount(account.id, { wrapper: 'roth_ira' }, user.id, tx);
      expect(saved.wrapper).toBe('roth_ira');
    });
  });

  test('an untouched wrapper survives an update of another field', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'investment');
      await service().updateAccount(account.id, { wrapper: 'sipp' }, user.id, tx);
      const saved = await service().updateAccount(account.id, { name: 'Pension' }, user.id, tx);
      expect(saved.wrapper).toBe('sipp');
    });
  });

  test('refuses a wrapper on a liability account', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'mortgage');
      await expect(
        service().updateAccount(account.id, { wrapper: 'isa' }, user.id, tx)
      ).rejects.toBeInstanceOf(WrapperOnLiabilityAccount);
    });
  });

  test('refuses an unknown wrapper code', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'investment');
      await expect(
        service().updateAccount(account.id, { wrapper: 'ppf' }, user.id, tx)
      ).rejects.toBeInstanceOf(UnknownWrapper);
    });
  });

  test('refuses investment -> mortgage and mortgage -> savings, with a readable reason', async () => {
    await withTestDb(async (tx) => {
      const asset = await setup(tx, 'investment');
      const toDebt = service().updateAccount(
        asset.account.id,
        { typeId: await typeId(tx, 'mortgage') },
        asset.user.id,
        tx
      );
      await expect(toDebt).rejects.toBeInstanceOf(AccountClassChange);
      await expect(toDebt).rejects.toThrow(/sign/);

      const debt = await setup(tx, 'mortgage');
      await expect(
        service().updateAccount(
          debt.account.id,
          { typeId: await typeId(tx, 'savings') },
          debt.user.id,
          tx
        )
      ).rejects.toBeInstanceOf(AccountClassChange);
    });
  });

  test('a type change inside one class succeeds and keeps the wrapper', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'investment');
      await service().updateAccount(account.id, { wrapper: 'tfsa' }, user.id, tx);
      const saved = await service().updateAccount(
        account.id,
        { typeId: await typeId(tx, 'savings') },
        user.id,
        tx
      );
      expect(saved.wrapper).toBe('tfsa');
    });
  });

  test('create takes a wrapper and refuses one on a liability type', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx, { createdByUserId: user.id });
      const created = await service().createAccount(
        {
          name: 'ISA',
          institutionId: institution.id,
          typeId: await typeId(tx, 'investment'),
          wrapper: 'isa',
        },
        user.id,
        tx
      );
      expect(created.wrapper).toBe('isa');
      await expect(
        service().createAccount(
          {
            name: 'Loan',
            institutionId: institution.id,
            typeId: await typeId(tx, 'loan'),
            wrapper: 'isa',
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(WrapperOnLiabilityAccount);
    });
  });
});
