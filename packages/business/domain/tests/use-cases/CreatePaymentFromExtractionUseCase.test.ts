import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../src/repositories/PaymentOccurrenceRepository';
import { VendorRepository } from '../../src/repositories/VendorRepository';
import {
  type CreatePaymentFromExtractionInput,
  CreatePaymentFromExtractionUseCase,
  ExtractionNotFoundError,
} from '../../src/use-cases/CreatePaymentFromExtractionUseCase';
import { withTestDb } from '../../test/helpers/db';
import {
  makeDocument,
  makeDocumentExtraction,
  makeUser,
  makeVendor,
} from '../../test/helpers/factories';
import { makeToken } from '../../test/helpers/factories-extra';

// The bridge from an approved invoice to a recurring payment. The three
// behaviours pinned here are the ones a partial implementation gets
// wrong and a type-check can't catch: an extraction id from another user
// must be refused (the table has no `userId` — ownership is join-derived
// through `documents`), a second invoice from the same vendor must reuse
// the vendor the first one created rather than trip
// `vendors_user_normalized_unique`, and `markAnchorPaid: false` must
// leave the anchor occurrence alone.

const useCase = () => Container.get(CreatePaymentFromExtractionUseCase);
const occurrences = () => Container.get(PaymentOccurrenceRepository);
const vendors = () => Container.get(VendorRepository);

const ANCHOR_DATE = '2026-07-26';

function inputFor(
  extractionId: string,
  currencyTokenId: string,
  overrides: Partial<CreatePaymentFromExtractionInput> = {}
): CreatePaymentFromExtractionInput {
  return {
    extractionId,
    direction: 'outflow',
    kind: 'fixed',
    expectedAmount: '35.88',
    currencyTokenId,
    intervalUnit: 'year',
    intervalCount: 1,
    anchorDate: ANCHOR_DATE,
    markAnchorPaid: false,
    ...overrides,
  };
}

describe('CreatePaymentFromExtractionUseCase', () => {
  test("refuses an extraction id belonging to another user's document", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeUser(tx);
      const intruder = await makeUser(tx);
      const token = await makeToken(tx);
      const document = await makeDocument(tx, { userId: owner.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: '1Password',
      });

      await expect(
        useCase().execute(intruder.id, inputFor(extraction.id, token.id), tx)
      ).rejects.toThrow(ExtractionNotFoundError);

      // Nothing leaked into the intruder's account, and the owner's
      // extraction is untouched.
      const payments = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.userId, intruder.id));
      expect(payments).toHaveLength(0);

      const [row] = await tx
        .select()
        .from(schema.documentExtractions)
        .where(eq(schema.documentExtractions.id, extraction.id));
      expect(row?.reviewState).toBe('pending');
    });
  });

  test('reuses an existing vendor rather than creating a duplicate, matching on the normalised name', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const token = await makeToken(tx);
      // Spelling noise only — `normalizeVendorName` collapses case and
      // punctuation, so this must resolve to the SAME vendor.
      const existing = await makeVendor(tx, { userId: user.id, displayName: '1Password' });
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: '  1password ',
      });

      const payment = await useCase().execute(user.id, inputFor(extraction.id, token.id), tx);

      expect(payment.vendorId).toBe(existing.id);
      const allVendors = await vendors().findByUser(user.id, tx);
      expect(allVendors).toHaveLength(1);
    });
  });

  test('creates the vendor when nothing matches the extraction vendorNameRaw', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const token = await makeToken(tx);
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: 'AgileBits Inc.',
      });

      const payment = await useCase().execute(user.id, inputFor(extraction.id, token.id), tx);

      const allVendors = await vendors().findByUser(user.id, tx);
      expect(allVendors).toHaveLength(1);
      expect(allVendors[0]?.id).toBe(payment.vendorId);
      expect(allVendors[0]?.displayName).toBe('AgileBits Inc.');
      expect(allVendors[0]?.normalizedName).toBe('agilebits inc');
    });
  });

  test('markAnchorPaid: false leaves the anchor occurrence scheduled and unlinked', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const token = await makeToken(tx);
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: '1Password',
      });

      const payment = await useCase().execute(
        user.id,
        inputFor(extraction.id, token.id, { markAnchorPaid: false }),
        tx
      );

      const anchor = await occurrences().findByPaymentIdAndDueDate(payment.id, ANCHOR_DATE, tx);
      expect(anchor).not.toBeNull();
      expect(anchor?.status).toBe('scheduled');
      expect(anchor?.actualAmount).toBeNull();
      expect(anchor?.matchedExtractionId).toBeNull();
    });
  });

  test('markAnchorPaid: true settles the anchor occurrence against the extraction', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const token = await makeToken(tx);
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: '1Password',
      });

      const payment = await useCase().execute(
        user.id,
        inputFor(extraction.id, token.id, { markAnchorPaid: true }),
        tx
      );

      const anchor = await occurrences().findByPaymentIdAndDueDate(payment.id, ANCHOR_DATE, tx);
      expect(anchor?.status).toBe('matched');
      expect(anchor?.actualAmount).toBe('35.88');
      expect(anchor?.matchedExtractionId).toBe(extraction.id);

      // Only the anchor is settled — the next yearly instance stays due.
      const all = await occurrences().findByPaymentId(payment.id, tx);
      expect(all.filter((o) => o.status === 'matched')).toHaveLength(1);
      expect(all.length).toBeGreaterThan(1);
    });
  });

  test('accepts the extraction and stamps the payment as document-originated', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const token = await makeToken(tx);
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: '1Password',
      });

      const payment = await useCase().execute(user.id, inputFor(extraction.id, token.id), tx);

      expect(payment.origin).toBe('document');
      const [row] = await tx
        .select()
        .from(schema.documentExtractions)
        .where(eq(schema.documentExtractions.id, extraction.id));
      expect(row?.reviewState).toBe('accepted');
    });
  });

  test('honours an explicit vendorId instead of deriving one from vendorNameRaw', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const token = await makeToken(tx);
      const chosen = await makeVendor(tx, { userId: user.id, displayName: 'AgileBits' });
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: '1Password',
      });

      const payment = await useCase().execute(
        user.id,
        inputFor(extraction.id, token.id, { vendorId: chosen.id }),
        tx
      );

      expect(payment.vendorId).toBe(chosen.id);
      const allVendors = await vendors().findByUser(user.id, tx);
      expect(allVendors).toHaveLength(1);
    });
  });

  test('refuses a vendorId belonging to another user', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const stranger = await makeUser(tx);
      const token = await makeToken(tx);
      const foreignVendor = await makeVendor(tx, { userId: stranger.id, displayName: 'Not Yours' });
      const document = await makeDocument(tx, { userId: user.id });
      const extraction = await makeDocumentExtraction(tx, {
        documentId: document.id,
        ordinal: 0,
        vendorNameRaw: '1Password',
      });

      await expect(
        useCase().execute(
          user.id,
          inputFor(extraction.id, token.id, { vendorId: foreignVendor.id }),
          tx
        )
      ).rejects.toThrow(/not found for user/);
    });
  });
});
