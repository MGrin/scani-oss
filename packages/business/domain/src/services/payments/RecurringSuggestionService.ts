import type { DatabaseTransaction } from '@scani/db';
import type { Payment } from '@scani/db/schema';
import { ANSWERABLE_OUTFLOW_KINDS, Decimal } from '@scani/shared';
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
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { VendorRepository } from '../../repositories/VendorRepository';
import { PriceHubResolver } from '../pricing/PriceHubResolver';
import {
  currencyClasses,
  detectMonthlyRecurrences,
  type ObservedOutflow,
} from './detectRecurrences';
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
  /** Each payment in its own coin: a series may mix coins worth the same. */
  evidence: { transactionId: string; date: string; amount: string; currencyTokenId: string }[];
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
  private readonly priceHubs = Container.get(PriceHubResolver);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);

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
        tx.counterparty &&
        tx.transferGroupId === null &&
        (tx.transferReview === null || tx.transferReview === 'left_control')
    );
    if (rows.length === 0) return [];

    const holdings = await this.holdingRepository.findByIds(
      [...new Set(rows.map((tx) => tx.holdingId))],
      transaction
    );
    const tokenOf = new Map(holdings.map((h) => [h.id, h.tokenId]));
    const byId = new Map(rows.map((tx) => [tx.id, tx]));

    const paid = rows.flatMap((tx) => {
      const tokenId = tokenOf.get(tx.holdingId);
      return tokenId
        ? [{ tx, tokenId, counterparty: vendorMatchKey(tx.counterparty as string) }]
        : [];
    });
    const classOf = await this.currencyClassesOf(paid, transaction);
    const tokenOfTx = new Map(paid.map((p) => [p.tx.id, p.tokenId]));
    const outflows: ObservedOutflow[] = paid.map(({ tx, tokenId, counterparty }) => ({
      id: tx.id,
      occurredAt: tx.occurredAt,
      amount: new Decimal(tx.quantity).abs().toString(),
      currency: classOf.get(tokenId) ?? tokenId,
      counterparty,
    }));

    const [covered, dismissed] = await Promise.all([
      this.coverage(userId, transaction),
      this.dismissals.keysForUser(userId, transaction),
    ]);

    return detectMonthlyRecurrences(outflows, asOf)
      .filter((found) => found.status === 'active')
      .map((found) => ({
        found,
        tokens: [...new Set(found.transactionIds.map((id) => tokenOfTx.get(id) as string))],
      }))
      .filter(
        ({ found, tokens }) =>
          !tokens.some((t) => dismissed.has(dismissalKey(found.counterparty, t))) &&
          !tokens.some((t) => covered.payees.has(dismissalKey(found.counterparty, t))) &&
          !found.transactionIds.some((id) => covered.transactionIds.has(id))
      )
      .map(({ found }) => {
        const matched = found.transactionIds.map((id) => byId.get(id)).filter((tx) => !!tx);
        const last = found.transactionIds.at(-1) as string;
        return {
          counterparty: (matched.at(-1)?.counterparty as string) ?? found.counterparty,
          counterpartyKey: found.counterparty,
          currencyTokenId: tokenOfTx.get(last) as string,
          amount: found.amount,
          anchorDate: isoDate(found.lastAt),
          evidence: matched.map((tx) => ({
            transactionId: tx.id,
            date: isoDate(tx.occurredAt),
            amount: new Decimal(tx.quantity).abs().toString(),
            currencyTokenId: tokenOfTx.get(tx.id) as string,
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

  /**
   * Priced only for a payee paid in more than one token, so the common case
   * reads no prices at all. Prices are compared in USD because that is the
   * base every stablecoin and forex edge is stored against.
   */
  private async currencyClassesOf(
    paid: { tokenId: string; counterparty: string }[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, string>> {
    const tokensByPayee = new Map<string, Set<string>>();
    for (const { counterparty, tokenId } of paid) {
      tokensByPayee.set(counterparty, (tokensByPayee.get(counterparty) ?? new Set()).add(tokenId));
    }
    const mixed = new Set(
      [...tokensByPayee.values()].filter((tokens) => tokens.size > 1).flatMap((t) => [...t])
    );
    if (mixed.size === 0) return new Map();

    const usdId = await this.priceHubs.usdTokenId(transaction);
    const latest = await this.tokenPriceRepository.findLatestPricesForTokensAnyBase(
      [...mixed],
      usdId,
      transaction
    );
    const prices = new Map<string, string>();
    for (const [tokenId, row] of latest) {
      if (row.baseTokenId === usdId) prices.set(tokenId, row.price);
    }
    if (mixed.has(usdId)) prices.set(usdId, '1');
    return currencyClasses(mixed, prices);
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
