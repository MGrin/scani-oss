import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import type { AnswerBalanceGapInput, AnswerBalanceGapResult, BalanceGap } from '@scani/shared';
import {
  BALANCE_GAP_DATE_PROMPT_MIN_SPAN_MS,
  BALANCE_GAP_MIN_BASE_VALUE,
  BALANCE_GAP_SUPPRESSIONS,
  type BalanceGapSuppression,
  type BalanceGapSuppressionCounts,
  isLedgerWritingAnswer,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import {
  GAP_ANSWER_ROW_SOURCES,
  type GapAnswerReceipt,
  gapAnswerRowIds,
  readGapAnswerReceipt,
} from '../../lib/balances/gap-answer-receipt';
import { isExactReversal, unexplainedDrift } from '../../lib/balances/unexplained-drift';
import { FeedInputRepository } from '../../repositories/FeedInputRepository';
import type { BalanceGapCandidate } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { HoldingCacheWriter } from '../feeds/HoldingCacheWriter';
import { InTransitService } from '../portfolio/InTransitService';
import { PriceReader, type PriceSeries } from '../pricing/PriceReader';
import { type TransferResolveResult, TransferReviewService } from '../TransferReviewService';
import { AWAITING_LEDGER_MAX_MS, NIGHTLY_LEDGER_SOURCES } from '../transactions/ledger-cadence';
import {
  BalanceGapListingCache,
  balanceGapListingKey,
  holdsTravellingLeg,
  type TravellingLegs,
} from './BalanceGapListingCache';
import { ManualBalanceEditService } from './ManualBalanceEditService';

/** The list, plus what it left out and why. */
export interface BalanceGapListing {
  items: BalanceGap[];
  /** Every drifting interval found, before any suppression. */
  examined: number;
  suppressed: BalanceGapSuppressionCounts;
}

/** Why answering was refused. `null` on success. */
export type BalanceGapAnswerRefusal = 'gone' | 'already-answered' | 'no-longer-a-gap';

const SYNC_OBSERVATION_SOURCE = 'sync-capture';

/**
 * An answer the service refuses on its own terms, after it may already have
 * written inside the transaction. It is thrown rather than returned so that
 * the transaction rolls back; the router turns it into a 400 with this
 * message, where a plain `Error` became a 500 the reader could do nothing with.
 */
export class BalanceGapAnswerRejected extends Error {
  override readonly name = 'BalanceGapAnswerRejected';
}

function destinationRefusal(refusal: Extract<TransferResolveResult, { ok: false }>): string {
  switch (refusal.reason) {
    case 'own_wallet_destination':
      return 'That account is on the other side of a wallet boundary, so it cannot receive this transfer';
    case 'sum':
      return `The amounts do not add up to the ${refusal.expected} that left`;
    default:
      return 'That destination is no longer there — choose it again';
  }
}

@Service()
export class BalanceGapService {
  private readonly transfers = Container.get(TransferReviewService);
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly users = Container.get(UserRepository);
  private readonly tokens = Container.get(TokenRepository);
  private readonly priceReader = Container.get(PriceReader);
  private readonly manualBalanceEdits = Container.get(ManualBalanceEditService);
  private readonly listingCache = Container.get(BalanceGapListingCache);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly inTransit = Container.get(InTransitService);
  private readonly feedInputs = Container.get(FeedInputRepository);

  /**
   * The queue, and the accounting for what is not in it.
   *
   * Every gate but one is a property of the rows — the observation's source,
   * whether the owner booked something while the interval closed, whether the
   * next interval reverses it, what it is worth. The exception is
   * `awaiting-ledger` (SC-1665), which reads `now` for its bound, so a ledger
   * that never arrives cannot hold a gap past it.
   */
  async listPending(
    userId: string,
    now: Date = new Date(),
    tx?: DatabaseTransaction
  ): Promise<BalanceGapListing> {
    const candidates = await this.observations.findGapCandidatesForUser(userId, tx);
    const awaiting = await this.awaitingLedger(candidates, now, tx);
    const user = await this.users.findById(userId, tx);
    const baseCurrencyId = user?.baseCurrencyId ?? null;
    const baseCurrency = baseCurrencyId ? await this.currencyCode(baseCurrencyId, tx) : '';
    const travelling = await this.travellingLegs(userId, tx);

    // Over EVERY candidate's token and instant, a superset of what the listing
    // prices, so a price that lands for any of them is a different key.
    const prices =
      baseCurrencyId && candidates.length > 0
        ? await this.priceReader.series(
            candidates.map((candidate) => ({ tokenId: candidate.tokenId, at: candidate.to })),
            baseCurrencyId,
            tx
          )
        : null;

    return this.listingCache.getOrCompute(
      balanceGapListingKey(
        userId,
        baseCurrencyId,
        baseCurrency,
        prices?.fingerprint ?? '',
        candidates,
        { travelling, awaitingLedger: [...awaiting] }
      ),
      () => this.priceListing(candidates, prices, baseCurrency, travelling, awaiting)
    );
  }

  /**
   * The gaps whose holding's ledger is still read nightly and has not been
   * read since the balance landed, less than `AWAITING_LEDGER_MAX_MS` ago.
   * A ledger read with its balance has no entry and is never held.
   */
  private async awaitingLedger(
    candidates: readonly BalanceGapCandidate[],
    now: Date,
    tx?: DatabaseTransaction
  ): Promise<ReadonlySet<string>> {
    const open = candidates.filter(
      (c) =>
        c.gapReview === null &&
        c.source === SYNC_OBSERVATION_SOURCE &&
        now.getTime() - c.to.getTime() < AWAITING_LEDGER_MAX_MS
    );
    if (open.length === 0) return new Set();
    const readThrough = await this.feedInputs.findLedgerReadThroughByHolding(
      [...new Set(open.map((c) => c.holdingId))],
      NIGHTLY_LEDGER_SOURCES,
      tx
    );
    return new Set(
      open
        .filter((c) => {
          if (!readThrough.has(c.holdingId)) return false;
          const at = readThrough.get(c.holdingId);
          return !at || at < c.to;
        })
        .map((c) => c.observationId)
    );
  }

  /**
   * Where each transfer still in transit put its arrival leg (SC-1680). The
   * destination's provider reading does not hold that money yet, so the
   * interval looks short by it; the day-7 transit question owns that money,
   * and a balance-change question beside it would ask about it twice.
   */
  private async travellingLegs(userId: string, tx?: DatabaseTransaction): Promise<TravellingLegs> {
    const legs = new Map<string, number[]>();
    for (const open of await this.inTransit.openTransits(userId, tx)) {
      if (open.transit.arrived) continue;
      const instants = legs.get(open.destinationHoldingId) ?? [];
      instants.push(open.arrival.at.getTime());
      legs.set(open.destinationHoldingId, instants);
    }
    return legs;
  }

  private async priceListing(
    candidates: BalanceGapCandidate[],
    prices: PriceSeries | null,
    baseCurrency: string,
    travelling: TravellingLegs,
    awaiting: ReadonlySet<string>
  ): Promise<BalanceGapListing> {
    const suppressed = emptySuppressionCounts();

    // Drift for every candidate first, because the reversal test needs the
    // NEXT interval's drift and that neighbour may itself be suppressed or
    // already answered. Computing it lazily inside the filter would make one
    // gap's fate depend on the order the others were examined.
    const drifts = candidates.map((candidate) => driftOf(candidate));

    const items: BalanceGap[] = [];
    let examined = 0;
    const toPrice: Array<{ candidate: BalanceGapCandidate; drift: Decimal }> = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const drift = drifts[index];
      if (!candidate || !drift || drift.isZero()) continue;
      examined += 1;

      // Already answered — not a suppression. It left the queue because
      // somebody dealt with it, which is the queue working.
      if (candidate.gapReview !== null) continue;

      if (holdsTravellingLeg(travelling, candidate)) {
        suppressed['in-transit'] += 1;
        continue;
      }

      if (candidate.source !== SYNC_OBSERVATION_SOURCE) {
        suppressed['owner-stated'] += 1;
        continue;
      }

      if (awaiting.has(candidate.observationId)) {
        suppressed['awaiting-ledger'] += 1;
        continue;
      }

      if (this.isReversed(candidates, drifts, index)) {
        suppressed.reversed += 1;
        continue;
      }

      toPrice.push({ candidate, drift });
    }

    for (const { candidate, drift } of toPrice) {
      const unit = prices?.priceAt(candidate.tokenId, candidate.to)?.price;
      if (!unit) {
        suppressed.unpriceable += 1;
        continue;
      }
      const baseValue = drift.abs().mul(unit);

      if (baseValue.lt(BALANCE_GAP_MIN_BASE_VALUE)) {
        suppressed['below-threshold'] += 1;
        continue;
      }

      items.push({
        observationId: candidate.observationId,
        holdingId: candidate.holdingId,
        tokenSymbol: candidate.tokenSymbol,
        tokenTypeCode: candidate.tokenTypeCode,
        accountName: candidate.accountName,
        from: candidate.from.toISOString(),
        to: candidate.to.toISOString(),
        previousBalance: candidate.previousBalance,
        balance: candidate.balance,
        drift: drift.toString(),
        baseValue: baseValue.toString(),
        baseCurrency,
        transactionsApplied: candidate.transactionsApplied,
        datePrompted:
          candidate.to.getTime() - candidate.from.getTime() >= BALANCE_GAP_DATE_PROMPT_MIN_SPAN_MS,
      });
    }

    items.sort((a, b) => new Decimal(b.baseValue).comparedTo(new Decimal(a.baseValue)));

    return { items, examined, suppressed };
  }

  /**
   * The count and newest arrival, for the review feed's single aggregate row.
   *
   * Deliberately the same computation as `listPending` rather than a cheaper
   * approximation. A badge that counts a different set from the page it links
   * to sends people to an empty list, and the cheap version of this — count
   * every drifting interval — would say 258 where the page says 37.
   */
  async pendingSummary(userId: string): Promise<{ count: number; latestAt: Date | null }> {
    const { items } = await this.listPending(userId);
    const latestAt = items.reduce<Date | null>((newest, item) => {
      const at = new Date(item.to);
      return newest === null || at > newest ? at : newest;
    }, null);
    return { count: items.length, latestAt };
  }

  /**
   * Record the owner's answer, and write the ledger row it implies.
   *
   * The three `MANUAL_EDIT_CAUSES` go to `ManualBalanceEditService.record`,
   * which is the single writer for "a balance changed and here is what it
   * meant" — `flow` a `deposit`/`withdraw` at the date the owner gave,
   * `correction` a backdated restatement, `growth` nothing at all. `unknown`
   * writes no row and only stamps the review.
   *
   * The gap is re-derived here rather than trusted from the client. A queue
   * page can be minutes old, and in between an import can have landed the
   * very transaction that explains the change — answering then would book a
   * second copy of it. `no-longer-a-gap` is that case, and it is a refusal
   * rather than a silent success because the two are worth telling apart.
   */
  async answer(
    userId: string,
    input: AnswerBalanceGapInput,
    now: Date = new Date(),
    transaction?: DatabaseTransaction
  ): Promise<{ result: AnswerBalanceGapResult } | { refusal: BalanceGapAnswerRefusal }> {
    if (!transaction) return getDb().transaction((tx) => this.answer(userId, input, now, tx));
    const observation = await this.observations.lockForGapAnswer(
      input.observationId,
      userId,
      transaction
    );
    if (!observation) return { refusal: 'no-longer-a-gap' };
    const metadata = (observation.sourceMetadata ?? {}) as Record<string, unknown>;
    const receipt = metadata.gapAnswer as
      | { request: string; result: AnswerBalanceGapResult }
      | undefined;
    const request = JSON.stringify({
      answer: input.answer,
      occurredAt: input.occurredAt?.toISOString() ?? null,
      editOutflow: input.editOutflow ?? null,
      receivedQuantity: input.receivedQuantity ?? null,
      parts: input.parts ?? null,
    });
    if (observation.gapReview !== null) {
      if (receipt?.request === request) return { result: receipt.result };
      return { refusal: 'already-answered' };
    }
    const candidates = await this.observations.findGapCandidatesForUser(userId, transaction);
    const candidate = candidates.find((row) => row.observationId === input.observationId);
    if (!candidate) return { refusal: 'no-longer-a-gap' };
    const drift = driftOf(candidate);
    if (drift.isZero()) return { refusal: 'no-longer-a-gap' };
    // Not in the queue while a transfer is in transit through it (SC-1680).
    if (holdsTravellingLeg(await this.travellingLegs(userId, transaction), candidate))
      return { refusal: 'no-longer-a-gap' };
    const holding = await this.holdings.findById(candidate.holdingId, transaction);
    if (!holding || holding.userId !== userId) return { refusal: 'gone' };
    if (input.receivedQuantity && input.editOutflow?.decision !== 'internal')
      throw new BalanceGapAnswerRejected(
        'A received amount only applies when the money moved to one of your own accounts'
      );
    if (input.editOutflow && (input.answer !== 'flow' || !drift.isNegative()))
      throw new BalanceGapAnswerRejected('A destination can only be given for money that left');
    if (input.parts) {
      if (input.answer !== 'flow' || !drift.isNegative())
        throw new BalanceGapAnswerRejected('Only money that left can be divided');
      if (input.editOutflow || input.receivedQuantity)
        throw new BalanceGapAnswerRejected('Give either one destination or the parts, not both');
      if (input.parts.some((part) => part.decision === 'paired'))
        throw new BalanceGapAnswerRejected('A balance change has no deposit to pair a part with');
    }
    const occurredAt = clampToInterval(input.occurredAt ?? candidate.to, candidate);
    const written = isLedgerWritingAnswer(input.answer)
      ? await this.manualBalanceEdits.record(
          {
            holding,
            previousBalance: candidate.previousBalance,
            newBalance: new Decimal(candidate.previousBalance).add(drift).toString(),
            cause: input.answer,
            occurredAt,
            editedAt: candidate.to,
            ...(input.editOutflow?.feeQuantity
              ? { fee: new Decimal(input.editOutflow.feeQuantity) }
              : {}),
          },
          transaction
        )
      : null;
    if (input.editOutflow) {
      if (!written?.transactionId) throw new Error('Withdrawal was not recorded');
      const resolved = await this.transfers.resolve(
        userId,
        written.transactionId,
        input.editOutflow.decision,
        {
          destination: input.editOutflow.destination,
          transaction,
          observedEvent: true,
          receivedQuantity: input.receivedQuantity,
        }
      );
      if (!resolved.ok) throw new BalanceGapAnswerRejected(destinationRefusal(resolved));
    }
    if (input.parts) {
      if (!written?.transactionId) throw new Error('Withdrawal was not recorded');
      // One withdrawal for the drift, divided: each move joins its group (SC-1665).
      const divided = await this.transfers.resolveSplit(
        userId,
        written.transactionId,
        input.parts,
        {
          transaction,
          observedEvent: true,
        }
      );
      if (!divided.ok)
        throw new BalanceGapAnswerRejected(
          divided.reason === 'invalid' ? divided.message : destinationRefusal(divided)
        );
    }
    const result: AnswerBalanceGapResult = {
      observationId: candidate.observationId,
      answer: input.answer,
      wroteKind: written?.kind ?? null,
      occurredAt:
        written?.kind === 'deposit' || written?.kind === 'withdraw'
          ? occurredAt.toISOString()
          : null,
    };
    const stamped = await this.observations.setGapReview(
      {
        observationId: candidate.observationId,
        userId,
        answer: input.answer,
        source: 'user',
        reviewedAt: now,
      },
      transaction
    );
    if (!stamped) throw new Error('Observation disappeared');
    await transaction
      .update(schema.holdingBalanceObservations)
      .set({
        sourceMetadata: {
          ...metadata,
          gapAnswer: {
            request,
            result,
            transactionId: written?.transactionId ?? null,
            feeTransactionId: written?.fee?.transactionId ?? null,
            answeredAt: now.toISOString(),
          },
        },
      })
      .where(eq(schema.holdingBalanceObservations.id, candidate.observationId));
    if (written?.transactionId) {
      await transaction
        .update(schema.holdingTransactions)
        .set({
          sourceMetadata: {
            gapObservationId: candidate.observationId,
            gapFrom: candidate.from.toISOString(),
            gapTo: candidate.to.toISOString(),
            cause: input.answer,
            editedAt: candidate.to.toISOString(),
            previousBalance: candidate.previousBalance,
            newBalance: new Decimal(candidate.previousBalance).add(drift).toString(),
          },
        })
        .where(eq(schema.holdingTransactions.id, written.transactionId));
    }
    // The fee needs the same window, or a later import of the real fee can
    // never replace it and the charge is counted twice.
    if (written?.fee?.transactionId) {
      await transaction
        .update(schema.holdingTransactions)
        .set({
          sourceMetadata: sql`${schema.holdingTransactions.sourceMetadata} || ${JSON.stringify({
            gapObservationId: candidate.observationId,
            gapFrom: candidate.from.toISOString(),
            gapTo: candidate.to.toISOString(),
          })}::jsonb`,
        })
        .where(eq(schema.holdingTransactions.id, written.fee.transactionId));
    }
    // The answer's rows are evidence; the cache follows them (A5 D-18).
    if (written?.transactionId) await this.cacheWriter.refresh(userId, [holding.id], transaction);
    return { result };
  }

  async crossCurrencyDestinations(userId: string, holdingId: string) {
    const holding = await this.holdings.findById(holdingId);
    if (!holding || holding.userId !== userId) return [];
    return getDb()
      .select({
        holdingId: schema.holdings.id,
        accountId: schema.holdings.accountId,
        accountName: schema.accounts.name,
        tokenSymbol: schema.tokens.symbol,
      })
      .from(schema.holdings)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
      .where(
        and(
          eq(schema.holdings.userId, userId),
          eq(schema.accounts.userId, userId),
          eq(schema.holdings.isActive, true),
          ne(schema.holdings.tokenId, holding.tokenId)
        )
      );
  }

  async listAnswered(userId: string) {
    return getDb()
      .select({
        observationId: schema.holdingBalanceObservations.id,
        answer: schema.holdingBalanceObservations.gapReview,
        reviewedAt: schema.holdingBalanceObservations.gapReviewedAt,
        tokenSymbol: schema.tokens.symbol,
        accountName: schema.accounts.name,
      })
      .from(schema.holdingBalanceObservations)
      .innerJoin(
        schema.holdings,
        eq(schema.holdings.id, schema.holdingBalanceObservations.holdingId)
      )
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .where(
        and(
          eq(schema.holdingBalanceObservations.userId, userId),
          isNotNull(schema.holdingBalanceObservations.gapReview)
        )
      );
  }

  async undo(
    userId: string,
    observationId: string,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    if (!transaction) return getDb().transaction((tx) => this.undo(userId, observationId, tx));
    const observation = await this.observations.lockForGapAnswer(
      observationId,
      userId,
      transaction
    );
    if (!observation?.gapReview) return false;
    const metadata = (observation.sourceMetadata ?? {}) as Record<string, unknown>;
    await this.removeAnswerRows(userId, readGapAnswerReceipt(metadata), transaction);
    const { gapAnswer: priorAnswer, ...rest } = metadata;
    await transaction
      .update(schema.holdingBalanceObservations)
      .set({
        gapReview: null,
        gapReviewedAt: null,
        gapReviewSource: null,
        sourceMetadata: {
          ...rest,
          previousGapAnswer: priorAnswer ?? { answer: observation.gapReview },
        },
      })
      .where(eq(schema.holdingBalanceObservations.id, observationId));
    return true;
  }

  /**
   * Take an answer's rows out of the ledger: reopen the transfer review its
   * withdrawal settled, which removes an arrival it booked on another holding,
   * then delete the rows the answer itself wrote. `undo` and the settlement
   * review's retire both go through here so they remove the same set (SC-1453).
   */
  async removeAnswerRows(
    userId: string,
    receipt: GapAnswerReceipt | undefined,
    transaction: DatabaseTransaction
  ): Promise<void> {
    if (receipt?.transactionId)
      await this.transfers.reopen(userId, receipt.transactionId, transaction);
    const ids = gapAnswerRowIds(receipt);
    if (ids.length === 0) return;
    const removed = await transaction
      .delete(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          inArray(schema.holdingTransactions.id, ids),
          inArray(schema.holdingTransactions.source, [...GAP_ANSWER_ROW_SOURCES])
        )
      )
      .returning({ holdingId: schema.holdingTransactions.holdingId });
    // The rows are gone, so the engine's balance may have moved (A5 D-18).
    await this.cacheWriter.refresh(
      userId,
      [...new Set(removed.map((row) => row.holdingId))],
      transaction
    );
  }

  /**
   * Does the next interval on this holding take the drift straight back?
   *
   * Checked in both directions, so the +172.85 and the −172.85 both leave the
   * queue. Suppressing only the second would leave the first sitting at the
   * top of the list as the largest thing in it, which is the failure the rule
   * exists to prevent rather than half of it.
   *
   * A transaction anywhere in either interval disqualifies the pair: if the
   * ledger has anything to say about the move, the balance really did change
   * and the remainder is a genuine gap, not a feed flicker.
   */
  private isReversed(
    candidates: ReadonlyArray<BalanceGapCandidate>,
    drifts: ReadonlyArray<Decimal>,
    index: number
  ): boolean {
    const self = candidates[index];
    const drift = drifts[index];
    if (!self || !drift || self.transactionsApplied > 0) return false;

    for (const neighbourIndex of [index - 1, index + 1]) {
      const neighbour = candidates[neighbourIndex];
      const neighbourDrift = drifts[neighbourIndex];
      if (!neighbour || !neighbourDrift) continue;
      if (neighbour.holdingId !== self.holdingId) continue;
      if (neighbour.transactionsApplied > 0) continue;
      if (isExactReversal(drift, neighbourDrift)) return true;
    }
    return false;
  }

  private async currencyCode(tokenId: string, tx?: DatabaseTransaction): Promise<string> {
    const token = await this.tokens.findById(tokenId, tx);
    return token?.symbol ?? '';
  }
}

/**
 * The interval's drift, from the row the repository returned.
 *
 * `explained` arrives already summed by Postgres, so it is handed to
 * `unexplainedDrift` as a one-element list rather than re-derived — the
 * function still owns the subtraction and the sign, which is the part two
 * copies would disagree about.
 */
function driftOf(candidate: BalanceGapCandidate): Decimal {
  return unexplainedDrift(candidate.previousBalance, candidate.balance, [candidate.explained]);
}

/**
 * The instant to stamp a flow with, forced inside `(from, to]`.
 *
 * Half-open at the lower end, exactly as `findTxsInRange` is: a transaction
 * stamped ON the earlier observation belongs to the interval before this one,
 * so `from` itself is one millisecond too early to be applied here.
 */
function clampToInterval(at: Date, candidate: BalanceGapCandidate): Date {
  const lower = candidate.from.getTime() + 1;
  const upper = candidate.to.getTime();
  return new Date(Math.min(Math.max(at.getTime(), lower), upper));
}

function emptySuppressionCounts(): BalanceGapSuppressionCounts {
  return Object.fromEntries(BALANCE_GAP_SUPPRESSIONS.map((reason) => [reason, 0])) as Record<
    BalanceGapSuppression,
    number
  >;
}
