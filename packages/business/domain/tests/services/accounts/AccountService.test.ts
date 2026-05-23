import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AccountService } from '../../../src/services/accounts/AccountService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount } from '../../../test/helpers/factories-extra';

// AccountService tests focus on the request-level methods that accept a
// transaction (createAccount, getAccountById). The dashboard-summary
// methods (getAccountsByUserIdWithSummary) are heavier and transitively
// pull in PortfolioValuationService + pricing — covered separately in
// PortfolioValuationService.test.ts.

const service = () => Container.get(AccountService);

describe('AccountService', () => {
  test('createAccount validates required fields', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await expect(
        service().createAccount(
          {
            // missing institutionId + typeId
            name: 'x',
          } as Parameters<typeof service>[0] extends never
            ? never
            : Parameters<AccountService['createAccount']>[0],
          user.id,
          tx
        )
      ).rejects.toThrow();
    });
  });

  test('createAccount rejects with a clear error when the institution is missing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await expect(
        service().createAccount(
          {
            institutionId: '00000000-0000-0000-0000-000000000000',
            typeId: '00000000-0000-0000-0000-000000000000',
            name: 'x',
          },
          user.id,
          tx
        )
      ).rejects.toThrow(/Institution with ID/);
    });
  });

  test('getAccountById refuses cross-user access', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, {
        userId: userA.id,
        institutionId: institution.id,
      });
      // userA — OK.
      const own = await service().getAccountById(userA.id, account.id, tx);
      expect(own.id).toBe(account.id);
      // userB — reject.
      await expect(service().getAccountById(userB.id, account.id, tx)).rejects.toThrow(
        /Access denied/
      );
    });
  });

  test('getAccountById throws when the account is missing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await expect(
        service().getAccountById(user.id, '00000000-0000-0000-0000-000000000000', tx)
      ).rejects.toThrow(/not found/);
    });
  });
});
