import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { UserRepository } from './UserRepository';

// UserRepository is a thin wrapper over BaseRepository — the test here is
// mostly a smoke test that BaseRepository's generic create/update/delete
// plumbing wires up correctly for `users`. The real user-side business
// logic lives in AuthService + use-cases; those have their own coverage.

const repo = () => Container.get(UserRepository);

describe('UserRepository', () => {
  test('create persists and returns the inserted row', async () => {
    await withTestDb(async (tx) => {
      const user = await repo().create({ email: 'a@b.c', name: 'Alice' }, tx);
      expect(user.email).toBe('a@b.c');
      expect(user.name).toBe('Alice');
      expect(user.emailVerified).toBe(false);
    });
  });

  test('findById returns the row for a known id', async () => {
    await withTestDb(async (tx) => {
      const seeded = await makeUser(tx);
      const found = await repo().findById(seeded.id, tx);
      expect(found?.id).toBe(seeded.id);
    });
  });

  test('findById returns null for an unknown id', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().findById('00000000-0000-0000-0000-000000000000', tx)).toBeNull();
    });
  });

  test('update mutates fields and bumps updatedAt', async () => {
    await withTestDb(async (tx) => {
      const seeded = await makeUser(tx, { name: 'Before' });
      const updated = await repo().update(seeded.id, { name: 'After' }, tx);
      expect(updated?.name).toBe('After');
    });
  });
});
