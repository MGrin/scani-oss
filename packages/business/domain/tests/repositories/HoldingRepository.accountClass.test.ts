import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// SC-1640: the allocation tells loan debt from margin debt by the account's
// class, so the holdings query it reads must carry it.

describe('HoldingRepository.findByUserWithFullDetails account class', () => {
  test('a mortgage holding reads liability and a default account reads asset', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const [mortgageType] = await tx
        .select({ id: schema.accountTypes.id })
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.code, 'mortgage'));
      const mortgage = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        typeId: mortgageType!.id,
      });
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      await makeHolding(tx, { userId: user.id, accountId: mortgage.id, tokenId: token.id });
      await makeHolding(tx, { userId: user.id, accountId: other.id, tokenId: token.id });

      const rows = await Container.get(HoldingRepository).findByUserWithFullDetails(
        user.id,
        undefined,
        tx
      );
      const classOf = (accountId: string) =>
        rows.find((r) => r.account.id === accountId)?.account.class;
      expect(classOf(mortgage.id)).toBe('liability');
      expect(classOf(other.id)).toBe('asset');
    });
  });

  test('findIdsOnLiabilityAccounts names only the mortgage holding', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const [mortgageType] = await tx
        .select({ id: schema.accountTypes.id })
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.code, 'mortgage'));
      const mortgage = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        typeId: mortgageType!.id,
      });
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      const debt = await makeHolding(tx, {
        userId: user.id,
        accountId: mortgage.id,
        tokenId: token.id,
      });
      const asset = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
      });
      const ids = await Container.get(HoldingRepository).findIdsOnLiabilityAccounts(
        [debt.id, asset.id],
        tx
      );
      expect([...ids]).toEqual([debt.id]);
    });
  });
});
