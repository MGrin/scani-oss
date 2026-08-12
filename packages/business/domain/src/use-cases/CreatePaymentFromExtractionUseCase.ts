/**
 * CreatePaymentFromExtractionUseCase
 *
 * The bridge between the review feed and the payments layer. Approving a
 * parsed invoice used to only flip `review_state` to 'accepted' — the row
 * vanished from the feed and nothing appeared anywhere else. This turns
 * that same approval into a real recurring payment, and (for an invoice
 * that was already PAID when it arrived — the common case for a receipt
 * forwarded from email) settles its anchor occurrence in the same breath
 * so the user doesn't have to immediately mark as paid something the
 * document already says they paid.
 *
 * Composition only, no new rules: vendor resolution goes through
 * `VendorRepository.findByAlias` + `normalizeVendorName` (the same
 * two-tier lookup `vendors.create` and `ReconcilePaymentsUseCase` use),
 * payment creation and occurrence materialisation go through
 * `PaymentService.create`, and settlement goes through
 * `PaymentService.settleOccurrence` — never a raw repository write, so
 * ownership enforcement stays in one place.
 *
 * CALLERS MUST PASS `transaction`. Five writes across four tables
 * (vendor, payment, occurrences, occurrence settle, review state) are not
 * one statement; a crash midway would leave a payment whose source
 * extraction is still sitting 'pending' in the review feed, so approving
 * it again would create a second, duplicate payment.
 */

import type { DatabaseTransaction } from '@scani/db';
import type { Payment, PaymentDirection, PaymentIntervalUnit, PaymentKind } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { normalizeVendorName } from '../lib/normalize-vendor-name';
import { DocumentExtractionRepository } from '../repositories/DocumentExtractionRepository';
import { PaymentOccurrenceRepository } from '../repositories/PaymentOccurrenceRepository';
import { VendorRepository } from '../repositories/VendorRepository';
import { PaymentService } from '../services/payments/PaymentService';

// Raised for both "no such extraction" and "belongs to another user's
// document" — the caller maps it to a plain NOT_FOUND, so this can't be
// used to probe for another user's extraction ids.
export class ExtractionNotFoundError extends Error {
  constructor(extractionId: string) {
    super(`Extraction ${extractionId} not found`);
    this.name = 'ExtractionNotFoundError';
  }
}

// Raised when `markAnchorPaid` was asked for but the recurrence rule
// produced no occurrence on `anchorDate` — only reachable with an
// `endDate` that precedes the anchor, which is a bad request, not a bug.
export class AnchorOccurrenceMissingError extends Error {
  constructor(anchorDate: string) {
    super(`No occurrence was materialised on the anchor date ${anchorDate}`);
    this.name = 'AnchorOccurrenceMissingError';
  }
}

export interface CreatePaymentFromExtractionInput {
  extractionId: string;
  // null / omitted means "derive the vendor from the extraction's own
  // `vendorNameRaw`", find-or-create.
  vendorId?: string | null;
  direction: PaymentDirection;
  kind: PaymentKind;
  expectedAmount?: string | null;
  currencyTokenId: string;
  intervalUnit: PaymentIntervalUnit;
  intervalCount: number;
  anchorDate: string; // 'YYYY-MM-DD'
  endDate?: string | null;
  accountId?: string | null;
  notes?: string | null;
  // The invoice says it was already paid: settle the anchor occurrence
  // immediately rather than leaving it scheduled and due.
  markAnchorPaid?: boolean;
}

@Service()
export class CreatePaymentFromExtractionUseCase {
  private readonly extractionRepository = Container.get(DocumentExtractionRepository);
  private readonly vendorRepository = Container.get(VendorRepository);
  private readonly occurrenceRepository = Container.get(PaymentOccurrenceRepository);
  private readonly paymentService = Container.get(PaymentService);

  async execute(
    userId: string,
    input: CreatePaymentFromExtractionInput,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    if (!userId) {
      throw new Error('CreatePaymentFromExtractionUseCase requires userId');
    }

    const extraction = await this.extractionRepository.findByIdAndUser(
      input.extractionId,
      userId,
      transaction
    );
    if (!extraction) {
      throw new ExtractionNotFoundError(input.extractionId);
    }

    const vendorId =
      input.vendorId ?? (await this.resolveVendorId(userId, extraction.vendorNameRaw, transaction));

    const payment = await this.paymentService.create(
      userId,
      {
        vendorId,
        direction: input.direction,
        kind: input.kind,
        expectedAmount: input.expectedAmount ?? null,
        currencyTokenId: input.currencyTokenId,
        intervalUnit: input.intervalUnit,
        intervalCount: input.intervalCount,
        anchorDate: input.anchorDate,
        endDate: input.endDate ?? null,
        accountId: input.accountId ?? null,
        notes: input.notes ?? null,
        origin: 'document',
      },
      transaction
    );

    if (input.markAnchorPaid) {
      const anchorOccurrence = await this.occurrenceRepository.findByPaymentIdAndDueDate(
        payment.id,
        input.anchorDate,
        transaction
      );
      if (!anchorOccurrence) {
        throw new AnchorOccurrenceMissingError(input.anchorDate);
      }
      await this.paymentService.settleOccurrence(
        userId,
        anchorOccurrence.id,
        {
          status: 'matched',
          actualAmount: input.expectedAmount ?? null,
          matchedExtractionId: extraction.id,
        },
        transaction
      );
    }

    const accepted = await this.extractionRepository.setReviewState(
      extraction.id,
      userId,
      'accepted',
      transaction
    );
    if (!accepted) {
      // Unreachable: `findByIdAndUser` above proved the same ownership
      // this re-checks, inside the same transaction.
      throw new ExtractionNotFoundError(extraction.id);
    }

    return payment;
  }

  /**
   * Find-or-create by NORMALISED name. `findByAlias` already does the
   * two-tier lookup (canonical `normalizedName`, then an explicit
   * `vendor_aliases.rawName`), which is why re-approving a second
   * 1Password invoice resolves to the vendor the first one created
   * instead of tripping `vendors_user_normalized_unique`.
   */
  private async resolveVendorId(
    userId: string,
    vendorNameRaw: string,
    transaction?: DatabaseTransaction
  ): Promise<string> {
    const existing = await this.vendorRepository.findByAlias(userId, vendorNameRaw, transaction);
    if (existing) return existing.id;

    const displayName = vendorNameRaw.trim();
    const created = await this.vendorRepository.create(
      {
        userId,
        displayName,
        normalizedName: normalizeVendorName(displayName),
      },
      transaction
    );
    return created.id;
  }
}
