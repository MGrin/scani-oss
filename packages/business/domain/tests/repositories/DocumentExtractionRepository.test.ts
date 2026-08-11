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
import { makePayment, makePaymentOccurrence } from '../../test/helpers/factories-extra';

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

  // Backs `documents.reparse`: a re-parse clears the stale reads but must
  // not strip a payment occurrence of the invoice that evidences it. The
  // FK is ON DELETE SET NULL, so a blanket delete would have succeeded and
  // silently orphaned the link — these tests pin that it doesn't.
  describe('deleteUnlinkedByDocumentId', () => {
    test('an extraction a payment occurrence points at survives; the rest go', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const document = await makeDocument(tx, { userId: user.id });
        const linked = await makeDocumentExtraction(tx, { documentId: document.id, ordinal: 0 });
        const pending = await makeDocumentExtraction(tx, {
          documentId: document.id,
          ordinal: 1,
          reviewState: 'pending',
        });
        const acceptedButUnlinked = await makeDocumentExtraction(tx, {
          documentId: document.id,
          ordinal: 2,
          reviewState: 'accepted',
        });
        const payment = await makePayment(tx, { userId: user.id });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-08-01',
          matchedExtractionId: linked.id,
        });

        const deleted = await repo().deleteUnlinkedByDocumentId(document.id, user.id, tx);

        expect(deleted.map((r) => r.id).sort()).toEqual(
          [pending.id, acceptedButUnlinked.id].sort()
        );
        const left = await repo().findByDocumentId(document.id, user.id, tx);
        expect(left.map((r) => r.id)).toEqual([linked.id]);
        // And the link itself is intact — not nulled by a cascade.
        const [occurrence] = await tx
          .select()
          .from(schema.paymentOccurrences)
          .where(eq(schema.paymentOccurrences.matchedExtractionId, linked.id));
        expect(occurrence).toBeDefined();
      });
    });

    test("another user's document is a no-op, not a delete", async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const intruder = await makeUser(tx);
        const document = await makeDocument(tx, { userId: owner.id });
        const extraction = await makeDocumentExtraction(tx, {
          documentId: document.id,
          ordinal: 0,
        });

        expect(await repo().deleteUnlinkedByDocumentId(document.id, intruder.id, tx)).toEqual([]);

        const left = await repo().findByDocumentId(document.id, owner.id, tx);
        expect(left.map((r) => r.id)).toEqual([extraction.id]);
      });
    });

    test('only the named document is touched', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const target = await makeDocument(tx, { userId: user.id });
        const other = await makeDocument(tx, { userId: user.id });
        await makeDocumentExtraction(tx, { documentId: target.id, ordinal: 0 });
        const untouched = await makeDocumentExtraction(tx, { documentId: other.id, ordinal: 0 });

        await repo().deleteUnlinkedByDocumentId(target.id, user.id, tx);

        expect(await repo().findByDocumentId(target.id, user.id, tx)).toEqual([]);
        expect((await repo().findByDocumentId(other.id, user.id, tx)).map((r) => r.id)).toEqual([
          untouched.id,
        ]);
      });
    });
  });
});
