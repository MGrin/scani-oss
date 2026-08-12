import { describe, expect, test } from 'bun:test';
import { DocumentRepository } from '../../src/repositories/DocumentRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeDocument, makeDocumentExtraction, makeUser } from '../../test/helpers/factories';

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

    test('permits the same hash across purposes, and repeatedly within a non-invoice one', async () => {
      // 0025 narrowed the unique to `WHERE purpose = 'invoice'`. Both halves
      // matter: an invoice and a screenshot that share bytes are unrelated
      // events, and a user re-uploading the same CSV after a failed import
      // must not hit a constraint violation that kills the retry.
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        await makeDocument(tx, { userId: user.id, contentHash: 'same-bytes' });

        await expect(
          makeDocument(tx, { userId: user.id, purpose: 'screenshot', contentHash: 'same-bytes' })
        ).resolves.toBeDefined();
        await expect(
          makeDocument(tx, { userId: user.id, purpose: 'file-import', contentHash: 'same-bytes' })
        ).resolves.toBeDefined();
        await expect(
          makeDocument(tx, { userId: user.id, purpose: 'file-import', contentHash: 'same-bytes' })
        ).resolves.toBeDefined();
      });
    });
  });

  describe('purpose', () => {
    test("a row inserted without a purpose classifies as 'invoice'", async () => {
      // This is what backfills history: every row written before 0025 came
      // from the invoice ingestion path, so the column default is the
      // migration's entire backfill strategy.
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const document = await makeDocument(tx, { userId: user.id });

        expect(document.purpose).toBe('invoice');
      });
    });

    test('findByPurposeAndContentHash is scoped to the purpose', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const screenshot = await makeDocument(tx, {
          userId: user.id,
          purpose: 'screenshot',
          contentHash: 'shared-bytes',
        });
        await makeDocument(tx, { userId: user.id, contentHash: 'shared-bytes' });

        const found = await repo().findByPurposeAndContentHash(
          user.id,
          'screenshot',
          'shared-bytes',
          tx
        );
        expect(found?.id).toBe(screenshot.id);
        expect(
          await repo().findByPurposeAndContentHash(user.id, 'file-import', 'shared-bytes', tx)
        ).toBeNull();
      });
    });
  });

  describe('listByUser', () => {
    const at = (iso: string) => new Date(iso);

    test("returns only the caller's files, newest first, with extraction counts", async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const other = await makeUser(tx);
        const invoice = await makeDocument(tx, {
          userId: owner.id,
          originalFilename: 'invoice.pdf',
          createdAt: at('2026-01-01T00:00:00Z'),
        });
        await makeDocumentExtraction(tx, { documentId: invoice.id, ordinal: 0 });
        await makeDocumentExtraction(tx, { documentId: invoice.id, ordinal: 1 });
        await makeDocument(tx, {
          userId: owner.id,
          purpose: 'screenshot',
          originalFilename: 'shot.png',
          createdAt: at('2026-02-01T00:00:00Z'),
        });
        await makeDocument(tx, { userId: other.id, originalFilename: 'theirs.pdf' });

        const rows = await repo().listByUser({ userId: owner.id, limit: 10 }, tx);

        expect(rows.map((r) => r.document.originalFilename)).toEqual(['shot.png', 'invoice.pdf']);
        // A screenshot has no extractions and must still appear — the count
        // is a subquery, not a join that would drop the row.
        expect(rows.map((r) => r.extractionCount)).toEqual([0, 2]);
      });
    });

    test('filters by purpose', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        await makeDocument(tx, { userId: user.id, originalFilename: 'invoice.pdf' });
        await makeDocument(tx, {
          userId: user.id,
          purpose: 'file-import',
          originalFilename: 'statement.csv',
        });

        const rows = await repo().listByUser(
          { userId: user.id, purpose: 'file-import', limit: 10 },
          tx
        );
        expect(rows.map((r) => r.document.originalFilename)).toEqual(['statement.csv']);
      });
    });

    test('reads limit + 1 so the caller can detect another page', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        for (let i = 0; i < 3; i++) {
          await makeDocument(tx, {
            userId: user.id,
            originalFilename: `f${i}.pdf`,
            createdAt: at(`2026-0${i + 1}-01T00:00:00Z`),
          });
        }

        expect(await repo().listByUser({ userId: user.id, limit: 2 }, tx)).toHaveLength(3);
      });
    });

    test('the cursor resumes after the row it names, including same-timestamp ties', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const sameInstant = at('2026-03-01T00:00:00Z');
        const a = await makeDocument(tx, {
          userId: user.id,
          originalFilename: 'a.pdf',
          createdAt: sameInstant,
        });
        const b = await makeDocument(tx, {
          userId: user.id,
          originalFilename: 'b.pdf',
          createdAt: sameInstant,
        });
        await makeDocument(tx, {
          userId: user.id,
          originalFilename: 'older.pdf',
          createdAt: at('2026-01-01T00:00:00Z'),
        });

        const first = await repo().listByUser({ userId: user.id, limit: 1 }, tx);
        const head = first[0];
        if (!head) throw new Error('expected a first page');

        const rest = await repo().listByUser(
          {
            userId: user.id,
            limit: 10,
            cursor: { createdAt: head.document.createdAt, id: head.document.id },
          },
          tx
        );

        // Ties break on id DESC, so the other same-instant row comes next
        // and neither is skipped nor repeated.
        const [tiedSibling] = [a.id, b.id].filter((id) => id !== head.document.id);
        expect(rest).toHaveLength(2);
        expect(rest[0]?.document.id).toBe(tiedSibling as string);
        expect(rest[1]?.document.originalFilename).toBe('older.pdf');
      });
    });
  });
});
