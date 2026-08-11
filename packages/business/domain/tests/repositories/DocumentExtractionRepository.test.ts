import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { DocumentExtractionRepository } from '../../src/repositories/DocumentExtractionRepository';
import { withTestDb } from '../../test/helpers/db';
import {
  makeDocument,
  makeDocumentExtraction,
  makeUser,
  makeVendor,
} from '../../test/helpers/factories';

// DocumentExtractionRepository backs the "one row per invoice FOUND IN a
// file" side of the documents layer — a single PDF can hold several,
// hence the `(document_id, ordinal)` unique rather than a 1:1 with
// `documents`. The tests below also pin the two FK-delete behaviours
// that matter for invoice history: deleting a document must cascade its
// extractions away, but deleting a vendor must NOT — it should only
// null out the link.

const repo = () => Container.get(DocumentExtractionRepository);

describe('DocumentExtractionRepository', () => {
  test('findPendingByUser returns only pending extractions scoped to the user', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const docA = await makeDocument(tx, { userId: userA.id });
      const docB = await makeDocument(tx, { userId: userB.id });
      const pending = await makeDocumentExtraction(tx, {
        documentId: docA.id,
        ordinal: 0,
        reviewState: 'pending',
      });
      await makeDocumentExtraction(tx, {
        documentId: docA.id,
        ordinal: 1,
        reviewState: 'accepted',
      });
      await makeDocumentExtraction(tx, { documentId: docB.id, ordinal: 0, reviewState: 'pending' });

      const rows = await repo().findPendingByUser(userA.id, tx);
      expect(rows.map((r) => r.id)).toEqual([pending.id]);
    });
  });

  describe('findByIdAndUser', () => {
    test("returns the extraction when it hangs off the caller's own document", async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const document = await makeDocument(tx, { userId: user.id });
        const extraction = await makeDocumentExtraction(tx, {
          documentId: document.id,
          ordinal: 0,
        });

        const found = await repo().findByIdAndUser(extraction.id, user.id, tx);
        expect(found?.id).toBe(extraction.id);
      });
    });

    test('returns null for an extraction on another user’s document', async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const intruder = await makeUser(tx);
        const document = await makeDocument(tx, { userId: owner.id });
        const extraction = await makeDocumentExtraction(tx, {
          documentId: document.id,
          ordinal: 0,
        });

        expect(await repo().findByIdAndUser(extraction.id, intruder.id, tx)).toBeNull();
      });
    });
  });

  describe('setReviewState', () => {
    test("updates an extraction that belongs to the caller's document", async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const document = await makeDocument(tx, { userId: user.id });
        const extraction = await makeDocumentExtraction(tx, {
          documentId: document.id,
          ordinal: 0,
        });

        const updated = await repo().setReviewState(extraction.id, user.id, 'accepted', tx);
        expect(updated?.reviewState).toBe('accepted');
      });
    });

    test('returns null and leaves the row untouched for a different user', async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const intruder = await makeUser(tx);
        const document = await makeDocument(tx, { userId: owner.id });
        const extraction = await makeDocumentExtraction(tx, {
          documentId: document.id,
          ordinal: 0,
        });

        const result = await repo().setReviewState(extraction.id, intruder.id, 'accepted', tx);
        expect(result).toBeNull();

        const [row] = await tx
          .select()
          .from(schema.documentExtractions)
          .where(eq(schema.documentExtractions.id, extraction.id));
        expect(row?.reviewState).toBe('pending');
      });
    });
  });

  describe('(document_id, ordinal) uniqueness', () => {
    test('permits ordinals 0 and 1 on the same document (a two-invoice PDF)', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const document = await makeDocument(tx, { userId: user.id });

        await expect(
          makeDocumentExtraction(tx, { documentId: document.id, ordinal: 0 })
        ).resolves.toBeDefined();
        await expect(
          makeDocumentExtraction(tx, { documentId: document.id, ordinal: 1 })
        ).resolves.toBeDefined();
      });
    });

    test('rejects a duplicate ordinal on the same document', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const document = await makeDocument(tx, { userId: user.id });
        await makeDocumentExtraction(tx, { documentId: document.id, ordinal: 0 });

        await expect(
          makeDocumentExtraction(tx, { documentId: document.id, ordinal: 0 })
        ).rejects.toThrow();
      });
    });
  });

  test('deleting a document cascades its extractions away', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, { documentId: document.id, ordinal: 0 });

      await tx.delete(schema.documents).where(eq(schema.documents.id, document.id));

      const [row] = await tx
        .select()
        .from(schema.documentExtractions)
        .where(eq(schema.documentExtractions.id, extraction.id));
      expect(row).toBeUndefined();
    });
  });

  test('deleting a vendor leaves the extraction alive with vendor_id NULL', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorId: vendor.id,
      });

      await tx.delete(schema.vendors).where(eq(schema.vendors.id, vendor.id));

      const [row] = await tx
        .select()
        .from(schema.documentExtractions)
        .where(eq(schema.documentExtractions.id, extraction.id));
      expect(row).toBeDefined();
      expect(row?.vendorId).toBeNull();
    });
  });
});
