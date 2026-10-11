import { createHash } from 'node:crypto';
import { StoreCommandTimeoutError, withDeadline } from '@scani/deadline';
import { createComponentLogger } from '@scani/logging';
import { getSharedRedis } from '@scani/rate-limiter';
import { BALANCE_GAP_MIN_BASE_VALUE } from '@scani/shared';
import { Service } from 'typedi';
import type { BalanceGapCandidate } from '../../repositories/HoldingBalanceObservationRepository';
import type { BalanceGapListing } from './BalanceGapService';

const logger = createComponentLogger('balance-gap-listing-cache');

// The key carries every candidate field, the base currency, the threshold and
// a fingerprint of the price rows the listing is priced from, so an answered or
// reopened gap, a new observation, a booked transaction or a price that lands
// is a different key and never a stale hit. The TTL bounds only what the key
// cannot see: a conversion the prefetch does not cover, which reads the
// database directly.
const TTL_SECONDS = 60 * 60;

// Same bound and reasoning as `PortfolioValueCache`: a spurious timeout costs
// exactly a cache miss, and an unbounded read never settles when Redis is down.
const REDIS_TIMEOUT_MS = 250;

@Service()
export class BalanceGapListingCache {
  async getOrCompute(
    key: string,
    factory: () => Promise<BalanceGapListing>
  ): Promise<BalanceGapListing> {
    const redis = getSharedRedis();
    if (!redis) return factory();

    try {
      const cached = await withDeadline(
        redis.get(key),
        REDIS_TIMEOUT_MS,
        () => new StoreCommandTimeoutError('redis', 'GET', REDIS_TIMEOUT_MS)
      );
      if (cached) return JSON.parse(cached) as BalanceGapListing;
    } catch (error) {
      logger.warn({ error, key }, 'Balance-gap listing cache read failed — recomputing');
    }

    const value = await factory();
    redis
      .set(key, JSON.stringify(value), 'EX', TTL_SECONDS)
      .catch((error) => logger.warn({ error, key }, 'Balance-gap listing cache write failed'));
    return value;
  }
}

/** Each open transit's arrival-leg instant (ms), by destination holding (SC-1680). */
export type TravellingLegs = ReadonlyMap<string, readonly number[]>;

/** Whether a gap's interval holds the arrival of a transfer still in transit. */
export function holdsTravellingLeg(
  travelling: TravellingLegs,
  candidate: Pick<BalanceGapCandidate, 'holdingId' | 'from' | 'to'>
): boolean {
  const from = candidate.from.getTime();
  const to = candidate.to.getTime();
  return (travelling.get(candidate.holdingId) ?? []).some((at) => at > from && at <= to);
}

export function balanceGapListingKey(
  userId: string,
  baseCurrencyId: string | null,
  baseCurrency: string,
  priceVersion: string,
  candidates: readonly BalanceGapCandidate[],
  held: {
    /** Where open transits' arrival legs sit: a transfer that lands or closes changes the queue (SC-1680). */
    travelling?: TravellingLegs;
    /** Gaps held for a nightly ledger read (SC-1665). */
    awaitingLedger?: readonly string[];
  } = {}
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([BALANCE_GAP_MIN_BASE_VALUE, baseCurrencyId, baseCurrency, priceVersion])
  );
  hash.update(
    JSON.stringify(
      [...(held.travelling ?? new Map()).entries()]
        .map(([holdingId, instants]) => [holdingId, [...instants].sort((a, b) => a - b)] as const)
        .sort(([a], [b]) => a.localeCompare(b))
    )
  );
  for (const c of candidates) {
    hash.update(
      JSON.stringify([
        c.observationId,
        c.holdingId,
        c.tokenId,
        c.tokenSymbol,
        c.tokenTypeCode,
        c.accountName,
        c.from.toISOString(),
        c.to.toISOString(),
        c.previousBalance,
        c.balance,
        c.explained,
        c.transactionsApplied,
        c.source,
        c.gapReview,
      ])
    );
  }
  hash.update(JSON.stringify([...(held.awaitingLedger ?? [])].sort()));
  return `bg:v3:${userId}:${hash.digest('hex')}`;
}
