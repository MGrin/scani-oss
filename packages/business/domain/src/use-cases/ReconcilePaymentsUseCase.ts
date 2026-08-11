/**
 * ReconcilePaymentsUseCase
 *
 * The opt-in, bonus half of occurrence resolution. With no bank
 * ingestion (Task 6 was dropped — see the payments plan), the user
 * marking an occurrence paid by hand via `PaymentService.settleOccurrence`
 * is the primary path and always works. This use case only helps for
 * payments tied to an account whose transactions actually flow into
 * `holding_transactions` (today: Airwallex) — a payment with no
 * `accountId` has nothing to match against and is skipped outright.
 *
 * Thin by design: all the judgement (direction/amount/date scoring,
 * the conservative auto-match threshold, tie-breaking to null) lives in
 * the pure `matchOccurrence`. This class only does the I/O `matchOccurrence`
 * deliberately can't: load scheduled occurrences, pull the account's
 * transactions in the surrounding window, resolve each transaction's
 * counterparty to a vendor via `VendorRepository.findByAlias`, and
 * persist a hit through `PaymentService.settleOccurrence` — never a raw
 * repository write, so settlement stays the single choke point that
 * enforces ownership and preserves `matchedTransactionId` on repeat runs.
 */

import type { DatabaseTransaction } from '@scani/db';
import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { PaymentOccurrenceRepository } from '../repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../repositories/PaymentRepository';
import { VendorRepository } from '../repositories/VendorRepository';
import {
  type MatchCandidate,
  type MatchOccurrenceOptions,
  matchOccurrence,
  type OccurrenceMatchStatus,
  type OccurrenceToMatch,
  type PaymentMatchDirection,
} from '../services/payments/matchOccurrences';
import { PaymentService } from '../services/payments/PaymentService';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// How far past the candidate-fetch window to look either side of an
// occurrence's due date, before `matchOccurrence`'s own (typically
// tighter) date-window scoring narrows it further. Only used to bound
// the DB query — the real conservatism lives in `matchOccurrence`.
const CANDIDATE_FETCH_PADDING_DAYS = 14;

export interface ReconcilePaymentsSummary {
  scanned: number;
  matched: number;
}

function parseUtcDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

@Service()
export class ReconcilePaymentsUseCase {
  private readonly paymentRepository = Container.get(PaymentRepository);
  private readonly occurrenceRepository = Container.get(PaymentOccurrenceRepository);
  private readonly transactionRepository = Container.get(HoldingTransactionRepository);
  private readonly vendorRepository = Container.get(VendorRepository);
  private readonly paymentService = Container.get(PaymentService);

  async execute(
    userId: string,
    opts: MatchOccurrenceOptions = {},
    transaction?: DatabaseTransaction
  ): Promise<ReconcilePaymentsSummary> {
    if (!userId) {
      throw new Error('ReconcilePaymentsUseCase requires userId');
    }

    const payments = (await this.paymentRepository.findByUser(userId, transaction)).filter(
      (payment) => payment.accountId !== null && payment.status === 'active'
    );

    let scanned = 0;
    let matched = 0;
    const vendorCache = new Map<string, string | null>();

    for (const payment of payments) {
      const accountId = payment.accountId;
      if (!accountId) continue;

      const occurrences = (
        await this.occurrenceRepository.findByPaymentId(payment.id, transaction)
      ).filter((occurrence) => occurrence.status === 'scheduled');
      if (occurrences.length === 0) continue;

      const dueDates = occurrences.map((occurrence) => parseUtcDateString(occurrence.dueDate));
      const paddingMs = CANDIDATE_FETCH_PADDING_DAYS * MS_PER_DAY;
      const from = new Date(Math.min(...dueDates.map((d) => d.getTime())) - paddingMs);
      const to = new Date(Math.max(...dueDates.map((d) => d.getTime())) + paddingMs);

      const transactions = await this.transactionRepository.findByRange(
        { userId, accountId, from, to },
        transaction
      );

      const candidates: MatchCandidate[] = [];
      for (const tx of transactions) {
        candidates.push({
          transactionId: tx.id,
          amount: tx.quantity,
          occurredAt: tx.occurredAt,
          accountId,
          vendorId: await this.resolveVendorId(userId, tx.counterparty, vendorCache, transaction),
        });
      }

      for (const occurrence of occurrences) {
        scanned += 1;
        const toMatch: OccurrenceToMatch = {
          dueDate: parseUtcDateString(occurrence.dueDate),
          expectedAmount: occurrence.expectedAmount,
          direction: payment.direction as PaymentMatchDirection,
          vendorId: payment.vendorId,
          accountId,
          status: occurrence.status as OccurrenceMatchStatus,
          matchedTransactionId: occurrence.matchedTransactionId,
        };

        const result = matchOccurrence(toMatch, candidates, opts);
        if (!result) continue;

        const matchedCandidate = candidates.find((c) => c.transactionId === result.transactionId);
        await this.paymentService.settleOccurrence(
          userId,
          occurrence.id,
          {
            status: 'matched',
            matchedTransactionId: result.transactionId,
            actualAmount: matchedCandidate
              ? new Decimal(matchedCandidate.amount).abs().toString()
              : undefined,
          },
          transaction
        );
        matched += 1;
      }
    }

    return { scanned, matched };
  }

  private async resolveVendorId(
    userId: string,
    counterparty: string | null,
    cache: Map<string, string | null>,
    transaction?: DatabaseTransaction
  ): Promise<string | null> {
    if (!counterparty) return null;
    if (cache.has(counterparty)) return cache.get(counterparty) ?? null;

    const vendor = await this.vendorRepository.findByAlias(userId, counterparty, transaction);
    const vendorId = vendor?.id ?? null;
    cache.set(counterparty, vendorId);
    return vendorId;
  }
}
