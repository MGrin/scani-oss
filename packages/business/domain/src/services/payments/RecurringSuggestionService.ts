import type { DatabaseTransaction } from '@scani/db';
import type { Payment } from '@scani/db/schema';
import { ANSWERABLE_OUTFLOW_KINDS } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { vendorMatchKey } from '../../lib/vendor-match-key';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { PaymentOccurrenceRepository } from '../../repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../repositories/PaymentRepository';
import {
  dismissalKey,
  RecurringSuggestionDismissalRepository,
} from '../../repositories/RecurringSuggestionDismissalRepository';
import { VendorRepository } from '../../repositories/VendorRepository';
import { detectMonthlyRecurrences, type ObservedOutflow } from './detectRecurrences';
import { PaymentService } from './PaymentService';

/** How far back the detector looks. A year plus a month, so a full year of monthly payments fits. */
const LOOKBACK_MONTHS = 13;

export interface RecurringSuggestion {
  /** The payee as the latest matching transaction named it. */
  counterparty: string;
  /** What a dismissal and an accept are keyed on (`vendorMatchKey`). */
  counterpartyKey: string;
  currencyTokenId: string;
  /** Median of the matched payments. */
  amount: string;
  /** YYYY-MM-DD of the latest matched payment; an accepted payment is anchored here. */
  anchorDate: string;
  evidence: { transactionId: string; date: string; amount: string }[];
}

export class SuggestionNotFoundError extends Error {
  constructor() {
    super('That recurring payment is not currently suggested');
    this.name = 'SuggestionNotFoundError';
  }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Recurring payments the user makes but never recorded (SC-674).
 *
 * Suggestions are derived on every read and never stored, and nothing is
 * written until the user accepts one: writing classifications the user did
 * not make is what cost the forecast his trust (SC-673). A dismissal is the
 * one thing kept, keyed on payee and currency, so it outlives the next sync.
 *
 * Only outflows that LEFT the user's control, or have not been answered yet,
 * are read. A monthly move to his own savings account is exactly the pattern
 * this detector would otherwise find, and it is not a bill.
 */
@Service()
export class RecurringSuggestionService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly paymentRepository = Container.get(PaymentRepository);
  private readonly occurrenceRepository = Container.get(PaymentOccurrenceRepository);
  private readonly vendorRepository = Container.get(VendorRepository);
  private readonly dismissals = Container.get(RecurringSuggestionDismissalRepository);
  private readonly paymentService = Container.get(PaymentService);

  async list(
    userId: string,
    asOf: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<RecurringSuggestion[]> {
    const from = new Date(asOf);
    from.setUTCMonth(from.getUTCMonth() - LOOKBACK_MONTHS);
    const rows = (
      await this.txRepository.findByRange(
        { userId, from, to: asOf, kinds: [...ANSWERABLE_OUTFLOW_KINDS] },
        transaction
      )
    ).filter(
      (tx) =>
        tx.counterparty && (tx.transferReview === null || tx.transferReview === 'left_control')
    );
    if (rows.length === 0) return [];

    const holdings = await this.holdingRepository.findByIds(
      [...new Set(rows.map((tx) => tx.holdingId))],
      transaction
    );
    const currencyOf = new Map(holdings.map((h) => [h.id, h.tokenId]));
    const byId = new Map(rows.map((tx) => [tx.id, tx]));

    const outflows: ObservedOutflow[] = rows.flatMap((tx) => {
      const currency = currencyOf.get(tx.holdingId);
      if (!currency) return [];
      return [
        {
          id: tx.id,
          occurredAt: tx.occurredAt,
          amount: new Decimal(tx.quantity).abs().toString(),
          currency,
          counterparty: vendorMatchKey(tx.counterparty as string),
        },
      ];
    });

    const [covered, dismissed] = await Promise.all([
      this.coverage(userId, transaction),
      this.dismissals.keysForUser(userId, transaction),
    ]);

    return detectMonthlyRecurrences(outflows, asOf)
      .filter((found) => found.status === 'active')
      .filter((found) => !dismissed.has(dismissalKey(found.counterparty, found.currency)))
      .filter(
        (found) =>
          !covered.payees.has(dismissalKey(found.counterparty, found.currency)) &&
          !found.transactionIds.some((id) => covered.transactionIds.has(id))
      )
      .map((found) => {
        const matched = found.transactionIds.map((id) => byId.get(id)).filter((tx) => !!tx);
        return {
          counterparty: (matched.at(-1)?.counterparty as string) ?? found.counterparty,
          counterpartyKey: found.counterparty,
          currencyTokenId: found.currency,
          amount: found.amount,
          anchorDate: isoDate(found.lastAt),
          evidence: matched.map((tx) => ({
            transactionId: tx.id,
            date: isoDate(tx.occurredAt),
            amount: new Decimal(tx.quantity).abs().toString(),
          })),
        };
      });
  }

  async dismiss(
    userId: string,
    counterpartyKey: string,
    currencyTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    await this.dismissals.dismiss(userId, counterpartyKey, currencyTokenId, transaction);
  }

  /**
   * Records the suggestion as a recurring payment. The amount, anchor and
   * payee come from the series as it stands now, never from the client: the
   * request names a suggestion, and a key that is not currently suggested is
   * refused rather than written.
   */
  async accept(
    userId: string,
    counterpartyKey: string,
    currencyTokenId: string,
    asOf: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    const suggestion = (await this.list(userId, asOf, transaction)).find(
      (s) => s.counterpartyKey === counterpartyKey && s.currencyTokenId === currencyTokenId
    );
    if (!suggestion) throw new SuggestionNotFoundError();

    const existing = await this.vendorRepository.resolve(
      userId,
      suggestion.counterparty,
      transaction
    );
    const vendorId =
      existing?.vendor.id ??
      (
        await this.vendorRepository.createForUser(
          userId,
          { displayName: suggestion.counterparty },
          transaction
        )
      ).id;

    return this.paymentService.create(
      userId,
      {
        vendorId,
        direction: 'outflow',
        kind: 'fixed',
        expectedAmount: suggestion.amount,
        currencyTokenId,
        intervalUnit: 'month',
        intervalCount: 1,
        anchorDate: suggestion.anchorDate,
        origin: 'detected',
      },
      transaction
    );
  }

  /** Payees an outflow payment already covers, and transactions already matched to one. */
  private async coverage(userId: string, transaction?: DatabaseTransaction) {
    const [payments, vendors] = await Promise.all([
      this.paymentRepository.findByUser(userId, transaction),
      this.vendorRepository.findByUser(userId, transaction),
    ]);
    const keyOf = new Map(vendors.map((v) => [v.id, v.matchKey]));
    const payees = new Set(
      payments
        .filter((p) => p.direction === 'outflow' && p.status !== 'ended')
        .map((p) => dismissalKey(keyOf.get(p.vendorId) ?? '', p.currencyTokenId))
    );
    const occurrences = await this.occurrenceRepository.findByPaymentIds(
      payments.map((p) => p.id),
      transaction
    );
    const transactionIds = new Set(
      occurrences.flatMap((o) => (o.matchedTransactionId ? [o.matchedTransactionId] : []))
    );
    return { payees, transactionIds };
  }
}
