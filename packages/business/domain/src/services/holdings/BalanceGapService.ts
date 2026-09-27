import type { AnswerBalanceGapResult, BalanceGap, BalanceGapAnswer } from '@scani/shared';
import {
  BALANCE_GAP_DATE_PROMPT_MIN_SPAN_MS,
  BALANCE_GAP_MIN_BASE_VALUE,
  BALANCE_GAP_SUPPRESSIONS,
  type BalanceGapSuppression,
  type BalanceGapSuppressionCounts,
  isLedgerWritingAnswer,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { isExactReversal, unexplainedDrift } from '../../lib/balances/unexplained-drift';
import type { BalanceGapCandidate } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { PriceGraphService } from '../pricing/PriceGraphService';
import { BalanceGapListingCache, balanceGapListingKey } from './BalanceGapListingCache';
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

@Service()
export class BalanceGapService {
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly users = Container.get(UserRepository);
  private readonly tokens = Container.get(TokenRepository);
  private readonly priceGraph = Container.get(PriceGraphService);
  private readonly manualBalanceEdits = Container.get(ManualBalanceEditService);
  private readonly listingCache = Container.get(BalanceGapListingCache);

  /**
   * The queue, and the accounting for what is not in it.
   *
   * Reads no clock. Every gate is a property of the rows — the observation's
   * source, whether the owner booked something while the interval closed,
   * whether the next interval reverses it, what it is worth — so the same
   * inputs always produce the same queue, and a gap does not appear or
   * disappear with the time of day.
   */
  async listPending(userId: string): Promise<BalanceGapListing> {
    const candidates = await this.observations.findGapCandidatesForUser(userId);
    const user = await this.users.findById(userId);
    const baseCurrencyId = user?.baseCurrencyId ?? null;
    const baseCurrency = baseCurrencyId ? await this.currencyCode(baseCurrencyId) : '';

    // Over EVERY candidate's token and instant, a superset of what the listing
    // prices, so a price that lands for any of them is a different key.
    const times = candidates.map((candidate) => candidate.to.getTime());
    const priceVersion =
      baseCurrencyId && candidates.length > 0
        ? await this.priceGraph.priceLookupFingerprint(
            candidates.map((candidate) => candidate.tokenId),
            baseCurrencyId,
            new Date(Math.max(...times)),
            new Date(Math.min(...times))
          )
        : '';

    return this.listingCache.getOrCompute(
      balanceGapListingKey(userId, baseCurrencyId, baseCurrency, priceVersion, candidates),
      () => this.priceListing(candidates, baseCurrencyId, baseCurrency)
    );
  }

  private async priceListing(
    candidates: BalanceGapCandidate[],
    baseCurrencyId: string | null,
    baseCurrency: string
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

      if (candidate.source !== SYNC_OBSERVATION_SOURCE) {
        suppressed['owner-stated'] += 1;
        continue;
      }

      if (this.isReversed(candidates, drifts, index)) {
        suppressed.reversed += 1;
        continue;
      }

      toPrice.push({ candidate, drift });
    }

    const priceLookup =
      baseCurrencyId && toPrice.length > 0
        ? await this.priceGraph.buildPriceLookup(
            toPrice.map(({ candidate }) => candidate.tokenId),
            baseCurrencyId,
            new Date(Math.max(...toPrice.map(({ candidate }) => candidate.to.getTime()))),
            undefined,
            new Date(Math.min(...toPrice.map(({ candidate }) => candidate.to.getTime())))
          )
        : undefined;

    for (const { candidate, drift } of toPrice) {
      const baseValue = baseCurrencyId
        ? await this.priceGraph.convert(
            drift.abs(),
            candidate.tokenId,
            baseCurrencyId,
            candidate.to,
            { tx: undefined, priceLookup }
          )
        : null;
      if (!baseValue) {
        suppressed.unpriceable += 1;
        continue;
      }

      if (baseValue.amount.lt(BALANCE_GAP_MIN_BASE_VALUE)) {
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
        baseValue: baseValue.amount.toString(),
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
    input: { observationId: string; answer: BalanceGapAnswer; occurredAt?: Date },
    now: Date = new Date()
  ): Promise<{ result: AnswerBalanceGapResult } | { refusal: BalanceGapAnswerRefusal }> {
    const candidates = await this.observations.findGapCandidatesForUser(userId);
    const index = candidates.findIndex((row) => row.observationId === input.observationId);
    const candidate = index >= 0 ? candidates[index] : undefined;
    if (!candidate) return { refusal: 'no-longer-a-gap' };
    if (candidate.gapReview !== null) return { refusal: 'already-answered' };

    const drift = driftOf(candidate);
    if (drift.isZero()) return { refusal: 'no-longer-a-gap' };

    const holding = await this.holdings.findById(candidate.holdingId);
    if (!holding || holding.userId !== userId) return { refusal: 'gone' };

    const occurredAt = clampToInterval(input.occurredAt ?? candidate.to, candidate);

    let wroteKind: AnswerBalanceGapResult['wroteKind'] = null;
    if (isLedgerWritingAnswer(input.answer)) {
      // `previousBalance` → `previousBalance + drift` is the delta the owner
      // is answering for, and it is NOT `previousBalance` → `balance`: the
      // transactions the ledger already holds for this interval explain their
      // own part of the move, and re-stating that part would double it.
      const written = await this.manualBalanceEdits.record({
        holding,
        previousBalance: candidate.previousBalance,
        newBalance: new Decimal(candidate.previousBalance).add(drift).toString(),
        cause: input.answer,
        // Only read for `flow`; `correction` is dated by the writer itself.
        occurredAt,
        // The dedup key is `manual-edit:<editedAt>`, so the CLOSING
        // observation's instant is what makes answering the same gap twice
        // collapse onto one row while two genuine gaps on one holding stay
        // two. `now` would make a retried mutation write a second deposit.
        editedAt: candidate.to,
      });
      wroteKind = written.kind;
    }

    const stamped = await this.observations.setGapReview({
      observationId: candidate.observationId,
      userId,
      answer: input.answer,
      source: 'user',
      reviewedAt: now,
    });
    if (!stamped) return { refusal: 'gone' };

    return {
      result: {
        observationId: candidate.observationId,
        answer: input.answer,
        wroteKind,
        // What the row was actually stamped with, so a clamp is visible to
        // the caller rather than a silent rewrite of somebody's answer.
        occurredAt:
          wroteKind === 'deposit' || wroteKind === 'withdraw' ? occurredAt.toISOString() : null,
      },
    };
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

  private async currencyCode(tokenId: string): Promise<string> {
    const token = await this.tokens.findById(tokenId);
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
