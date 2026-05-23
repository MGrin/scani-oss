import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { InstitutionService } from '../../../src/services/accounts/InstitutionService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitutionType, makeUser } from '../../../test/helpers/factories';

// InstitutionService.createInstitution is the write path behind "Add
// institution". The summary method pulls in portfolio valuation, so it
// lives in PortfolioValuationService.test.ts instead — keeping this file
// focused on the validation boundary.

const service = () => Container.get(InstitutionService);

describe('InstitutionService', () => {
  test('createInstitution inserts a row when fields are valid', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const type = await makeInstitutionType(tx);
      const created = await service().createInstitution(
        { name: 'Binance', typeId: type.id },
        user.id,
        tx
      );
      expect(created.name).toBe('Binance');
      expect(created.typeId).toBe(type.id);
      expect(created.isActive).toBe(true);
    });
  });

  test('createInstitution rejects an empty name', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const type = await makeInstitutionType(tx);
      await expect(
        service().createInstitution({ name: '   ', typeId: type.id }, user.id, tx)
      ).rejects.toThrow();
    });
  });

  test('createInstitution rejects when typeId is missing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await expect(
        service().createInstitution(
          {
            name: 'X',
          } as Parameters<InstitutionService['createInstitution']>[0],
          user.id,
          tx
        )
      ).rejects.toThrow();
    });
  });
});
