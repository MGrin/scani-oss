import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { InstitutionService } from '../../../src/services/accounts/InstitutionService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitutionType, makeUser } from '../../../test/helpers/factories';

// InstitutionService.ensureInstitution is the write path behind "Add
// institution". The summary method pulls in portfolio valuation, so it
// lives in PortfolioValuationService.test.ts instead — keeping this file
// focused on the validation boundary.

const service = () => Container.get(InstitutionService);

describe('InstitutionService', () => {
  test('ensureInstitution inserts a row when fields are valid', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const type = await makeInstitutionType(tx);
      const { institution, created } = await service().ensureInstitution(
        { name: 'Zzz Test Bank SC135', typeId: type.id },
        user.id,
        tx
      );
      expect(created).toBe(true);
      expect(institution.name).toBe('Zzz Test Bank SC135');
      expect(institution.typeId).toBe(type.id);
      expect(institution.isActive).toBe(true);
    });
  });

  // SC-135: the import flow's "Add <name>" sat directly under the matching
  // existing row, so a mis-tap produced a second identical institution
  // holding none of the user's accounts — and the next import then told
  // them the account did not exist.
  test('ensureInstitution reuses a same-name row instead of duplicating it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const type = await makeInstitutionType(tx);
      const first = await service().ensureInstitution(
        { name: 'Zzz Reuse Bank SC135', typeId: type.id },
        user.id,
        tx
      );
      const second = await service().ensureInstitution(
        { name: '  zzz reuse bank sc135 ', typeId: type.id },
        user.id,
        tx
      );
      expect(second.created).toBe(false);
      expect(second.institution.id).toBe(first.institution.id);
    });
  });

  test('ensureInstitution rejects an empty name', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const type = await makeInstitutionType(tx);
      await expect(
        service().ensureInstitution({ name: '   ', typeId: type.id }, user.id, tx)
      ).rejects.toThrow();
    });
  });

  test('ensureInstitution rejects when typeId is missing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await expect(
        service().ensureInstitution(
          {
            name: 'X',
          } as Parameters<InstitutionService['ensureInstitution']>[0],
          user.id,
          tx
        )
      ).rejects.toThrow();
    });
  });
});
