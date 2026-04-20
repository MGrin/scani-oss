import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';
import { InstitutionRepository } from './InstitutionRepository';

// findByUserId is the one that drives the "Institutions" screen + the
// institution-picker in add-holding. The critical contract is that the
// account-side filters MATCH `AccountRepository.findByUser` — otherwise an
// institution with only hidden accounts shows up with accountCount=0.
// Lock that contract here (see the inline comment in findByUserId).

const repo = () => Container.get(InstitutionRepository);

describe('InstitutionRepository', () => {
  test('findByUserId returns institutions reached via the user\u2019s visible accounts', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rows = await repo().findByUserId(user.id, tx);
      expect(rows.map((r) => r.id)).toContain(institution.id);
    });
  });

  test('findByUserId hides institutions whose only accounts are hidden', async () => {
    // Matches the comment in the method: account-side hiding filter must
    // line up with AccountRepository.findByUser.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        isHidden: true,
      });
      const rows = await repo().findByUserId(user.id, tx);
      expect(rows.map((r) => r.id)).not.toContain(institution.id);
    });
  });

  test('findByUserId hides institutions that are themselves inactive', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx, { isActive: false });
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rows = await repo().findByUserId(user.id, tx);
      expect(rows.map((r) => r.id)).not.toContain(institution.id);
    });
  });

  test('findByUserId returns distinct institutions even with multiple accounts', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      // Two accounts, same institution — institution must appear exactly once.
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rows = await repo().findByUserId(user.id, tx);
      const matching = rows.filter((r) => r.id === institution.id);
      expect(matching.length).toBe(1);
    });
  });

  test('findByUserId scopes by userId — cross-user isolation', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, { userId: userA.id, institutionId: institution.id });
      const aRows = await repo().findByUserId(userA.id, tx);
      const bRows = await repo().findByUserId(userB.id, tx);
      expect(aRows.map((r) => r.id)).toContain(institution.id);
      expect(bRows.map((r) => r.id)).not.toContain(institution.id);
    });
  });
});
