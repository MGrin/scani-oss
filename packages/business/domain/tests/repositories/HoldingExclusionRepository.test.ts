import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingExclusionRepository } from '../../src/repositories/HoldingExclusionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';

// The wallet-balances cron auto-discovers new tokens; these rows are the
// only memory of which tokens a user deliberately rejected at import
// review, so record / remove / lookup must be exact.

const repo = () => Container.get(HoldingExclusionRepository);

describe('HoldingExclusionRepository', () => {
  test('recordExclusions then findKeysByUser round-trips the keys', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);

      await repo().recordExclusions(
        user.id,
        [
          { institutionId: institution.id, externalId: 'ethereum:0xabc' },
          { institutionId: institution.id, externalId: 'native' },
        ],
        'user_unchecked',
        tx
      );

      const keys = await repo().findKeysByUser(user.id, tx);
      expect(keys.has(`${institution.id}:ethereum:0xabc`)).toBe(true);
      expect(keys.has(`${institution.id}:native`)).toBe(true);
      expect(keys.size).toBe(2);
    });
  });

  test('recordExclusions is idempotent on the unique key', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const entry = { institutionId: institution.id, externalId: 'ethereum:0xdup' };

      await repo().recordExclusions(user.id, [entry], 'user_unchecked', tx);
      await repo().recordExclusions(user.id, [entry], 'user_unchecked', tx);

      const keys = await repo().findKeysByUser(user.id, tx);
      expect(keys.size).toBe(1);
    });
  });

  test('removeExclusions deletes only the given keys', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const kept = { institutionId: institution.id, externalId: 'native' };
      const dropped = { institutionId: institution.id, externalId: 'ethereum:0xabc' };

      await repo().recordExclusions(user.id, [kept, dropped], 'user_unchecked', tx);
      await repo().removeExclusions(user.id, [dropped], tx);

      const keys = await repo().findKeysByUser(user.id, tx);
      expect(keys.has(`${institution.id}:native`)).toBe(true);
      expect(keys.has(`${institution.id}:ethereum:0xabc`)).toBe(false);
    });
  });

  test('findKeysByUser is scoped to the user', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const institution = await makeInstitution(tx);

      await repo().recordExclusions(
        userA.id,
        [{ institutionId: institution.id, externalId: 'native' }],
        'user_unchecked',
        tx
      );

      const keysB = await repo().findKeysByUser(userB.id, tx);
      expect(keysB.size).toBe(0);
    });
  });
});
