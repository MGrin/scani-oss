import type { CurrencyRef } from '@scani/domain/services';
import {
  CURRENCY_RATE_REFRESH,
  CURRENCY_RATE_REFRESH_COALESCE_MS,
  type CurrencyRateRefreshJob,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';

const logger = createComponentLogger('lib:currency-rate-refresh');

/**
 * Ask the worker to go and get the pairs a read could not answer (SC-222).
 *
 * The read path deliberately never fetches: the upstream call sits behind a
 * two-per-sixty-seconds limiter that sleeps, so doing it inline cost a user
 * 26 seconds for three currencies. This is the other half of that trade — the
 * figure renders now, honestly missing those parts, and the pair is resolvable
 * from storage by the time anyone looks again.
 *
 * Every failure here is swallowed. A rate refresh is an optimisation of a
 * later request; turning a queue outage into a failed Money tab would be
 * strictly worse than the missing rate it was trying to fix.
 */
export async function enqueueCurrencyRateRefresh(
  userId: string,
  base: CurrencyRef,
  missing: readonly CurrencyRef[]
): Promise<void> {
  if (missing.length === 0) return;

  // Bucketed wall clock, the same trick `enqueuePortfolioRollup` uses: the
  // jobId is (pair + requestId), so every request for the same pair inside one
  // window computes the same id and BullMQ drops the duplicates. Without it,
  // one deploy emptying the converter's memory cache turns every user opening
  // Money into another queued upstream call for the same handful of pairs.
  const requestId = `read-miss-${Math.floor(Date.now() / CURRENCY_RATE_REFRESH_COALESCE_MS)}`;
  const enqueue = Container.get(BullMqEnqueueService);

  // Deduplicated on token id, not symbol: two rows sharing a ticker are two
  // pairs and each needs its own row refreshed (SC-223).
  const uniqueByTokenId = new Map(missing.map((ref) => [ref.id, ref]));

  await Promise.all(
    Array.from(uniqueByTokenId.values()).map(async (from) => {
      const job: CurrencyRateRefreshJob = {
        userId,
        requestId,
        fromTokenId: from.id,
        fromSymbol: from.symbol,
        toTokenId: base.id,
        toSymbol: base.symbol,
      };
      try {
        await enqueue.add(CURRENCY_RATE_REFRESH, job);
      } catch (error) {
        logger.warn(
          { error, fromSymbol: from.symbol, baseSymbol: base.symbol },
          'Could not queue a currency-rate refresh'
        );
      }
    })
  );
}
