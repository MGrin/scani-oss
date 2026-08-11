import { describe, expect, test } from 'bun:test';
import { DocumentRepository } from '../../src/repositories/DocumentRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeDocument, makeUser } from '../../test/helpers/factories';

// DocumentRepository backs the "one row per uploaded FILE" side of the
// documents layer. The `(user_id, content_hash)` unique is the dedup
// that stops scanning and paying for the same invoice twice — the tests
// below prove it actually rejects, and that it's scoped per-user rather
// than global.

// Constructed directly, NOT via the Container: five service tests
// `Container.set(DocumentRepository, ...)` a partial stub, and typedi's
// container is process-global, so whichever ran first left this file
// resolving a stub with no `findByContentHash`. A real-DB repository
// test needs no DI anyway.
const repo = () => new DocumentRepository();

describe('DocumentRepository', () => {
  test("findByUser returns only that user's documents", async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      await makeDocument(tx, { userId: userA.id, originalFilename: 'a.pdf' });
      await makeDocument(tx, { userId: userA.id, originalFilename: 'b.pdf' });
      await makeDocument(tx, { userId: userB.id, originalFilename: 'c.pdf' });

      const rows = await repo().findByUser(userA.id, tx);
      expect(rows).toHaveLength(2);
      expect(rows.every((d) => d.userId === userA.id)).toBe(true);
    });
  });

  test('findByContentHash finds an existing document for the user', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const document = await makeDocument(tx, { userId: user.id, contentHash: 'hash-abc' });

      const found = await repo().findByContentHash(user.id, 'hash-abc', tx);
      expect(found?.id).toBe(document.id);
    });
  });

  test('findByContentHash returns undefined when nothing matches', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);

      expect(await repo().findByContentHash(user.id, 'nonexistent-hash', tx)).toBeUndefined();
    });
  });

  describe('(user_id, content_hash) uniqueness', () => {
    test('rejects a second insert of the same hash for the same user', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        await makeDocument(tx, { userId: user.id, contentHash: 'dup-hash' });

        await expect(
          makeDocument(tx, { userId: user.id, contentHash: 'dup-hash' })
        ).rejects.toThrow();
      });
    });

    test('permits the same hash for a different user', async () => {
      await withTestDb(async (tx) => {
        const userA = await makeUser(tx);
        const userB = await makeUser(tx);
        await makeDocument(tx, { userId: userA.id, contentHash: 'shared-hash' });

        await expect(
          makeDocument(tx, { userId: userB.id, contentHash: 'shared-hash' })
        ).resolves.toBeDefined();

        const foundA = await repo().findByContentHash(userA.id, 'shared-hash', tx);
        const foundB = await repo().findByContentHash(userB.id, 'shared-hash', tx);
        expect(foundA?.userId).toBe(userA.id);
        expect(foundB?.userId).toBe(userB.id);
      });
    });
  });
});
