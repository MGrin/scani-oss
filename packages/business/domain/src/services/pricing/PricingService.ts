import type { Token } from '@scani/db/schema';
import { logger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { HoldingCacheWriter } from '../feeds/HoldingCacheWriter';
import { PriceHubResolver } from './PriceHubResolver';
import { PriceReader } from './PriceReader';
import type { PairAt } from './PriceWriter';
import { PricingProviderRouter } from './PricingProviderRouter';
import { LIVE_PRICE_WINDOW_MS } from './price-windows';

/**
 * Asks the providers for prices, through `PricingProviderRouter`, which
 * stores what they answer and translates their failures through
 * `PricingFailureCacher`. Concurrent asks for the same tokens share one
 * fetch. Every stored price is read through `PriceReader` (foundation A3);
 * `token_prices` is read here only to decide whether to ask.
 */
@Service()
export class PricingService {
  private readonly ongoingRequests = new Map<string, Promise<Map<string, string>>>();

  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly providerRouter = Container.get(PricingProviderRouter);
  private readonly valueCache = Container.get(HoldingCacheWriter);
  private readonly priceHubs = Container.get(PriceHubResolver);
  private readonly priceReader = Container.get(PriceReader);

  /**
   * The token prices are asked in: the one with this id, or the fiat USD when
   * no id is given or no token carries it. An id no token carries is logged,
   * because it is a reference to a row that is gone. Never resolved from a
   * symbol, which names whichever token was created last under it.
   */
  async baseToken(baseCurrencyId?: string | null): Promise<Token> {
    if (baseCurrencyId) {
      const own = await this.tokenRepository.findById(baseCurrencyId);
      if (own) return own;
      logger.warn({ baseCurrencyId }, 'Base currency id names no token, pricing in the fiat USD');
    }
    const usd = await this.tokenRepository.findById(await this.priceHubs.usdTokenId());
    if (!usd) throw new Error('the catalogue has no fiat USD token');
    return usd;
  }

  // Ask for a price for `token` against the fiat USD, where every provider
  // quote is stored (D-4), and answer in `base` through `PriceReader`, as the
  // dashboard being refreshed reads it.
  //
  // Despite the name it does NOT guarantee a network call: `fetchUnlessCurrent`
  // leaves a token with a reading inside `LIVE_PRICE_WINDOW_MS` unasked, which
  // is the right behaviour — a manual refresh must not be a way to spend the
  // hourly rate-limit budget on a price that is already current.
  //
  // What it owes the caller is the DIFFERENCE. "Refresh price" reported a
  // green "BTC price refreshed" over a line that still read `25m ago`, because
  // the only signal it had was `success: true`, which meant "a price came
  // back" (SC-148). So the USD pair's latest row is read once before and once
  // after: the clock is Postgres's on both sides, which is what makes the
  // comparison exact rather than a guess about how long a fetch should take.
  async fetchAndStoreFreshPrice(
    token: Token,
    base: Token
  ): Promise<{
    price: string | null;
    source: string;
    timestamp: Date;
    /** False when the price returned is the one that was already stored. */
    fetched: boolean;
  }> {
    const now = new Date();
    const usd = await this.baseToken();
    const before = await this.tokenPriceRepository.findLatestPrice(token.id, usd.id);
    await this.fetchUnlessCurrent([token], now);
    const after = await this.tokenPriceRepository.findLatestPrice(token.id, usd.id);
    const answer = (await this.priceReader.at([token.id], base.id, now)).get(token.id) ?? null;

    const fetched =
      after !== null && (before === null || after.timestamp.getTime() > before.timestamp.getTime());

    return {
      price: answer?.price.toString() ?? null,
      source: answer?.source ?? 'unknown',
      timestamp: answer?.readingAt ?? now,
      fetched,
    };
  }

  /**
   * Asks the providers, against the fiat USD, for each token with no reading
   * against USD stamped within `LIVE_PRICE_WINDOW_MS` before `at` and no price
   * a person typed, in any base. An import or a refresh must not spend the
   * providers' budget on a price the hourly run has just fetched, or ask them
   * for one only a person gives. `windowMs` narrows "current" for the
   * quarter-hour run over what open apps show (SC-1602). Returns how many
   * tokens it asked for and how many cached holding values it wrote.
   */
  async fetchUnlessCurrent(
    tokens: Token[],
    at: Date,
    windowMs: number = LIVE_PRICE_WINDOW_MS
  ): Promise<{ asked: number; cacheWrites: number }> {
    const usd = await this.baseToken();
    const tokenIds = [...new Set(tokens.map((token) => token.id))].filter((id) => id !== usd.id);
    if (tokenIds.length === 0) return { asked: 0, cacheWrites: 0 };

    const [latest, typed] = await Promise.all([
      this.tokenPriceRepository.findLatestPricesForTokens(tokenIds, usd.id),
      this.tokenPriceRepository.findLatestManualPricesForTokensAnyBase(tokenIds),
    ]);
    const since = at.getTime() - windowMs;
    const isCurrent = (tokenId: string) =>
      typed.has(tokenId) || (latest.get(tokenId)?.timestamp.getTime() ?? -Infinity) >= since;

    const toAsk = tokens.filter((token) => token.id !== usd.id && !isCurrent(token.id));
    if (toAsk.length === 0) return { asked: 0, cacheWrites: 0 };
    const changed: PairAt[] = [];
    await this.getTokenPrices(toAsk, usd, at, changed);
    const cacheWrites = await this.revalueChanged(changed, at);
    return { asked: toAsk.length, cacheWrites };
  }

  /** A failure costs the cache only, which the nightly shadow then names (SC-1610). */
  async revalueChanged(changed: readonly PairAt[], at: Date): Promise<number> {
    try {
      return (await this.valueCache.revalueAffected(changed, at)).length;
    } catch (error) {
      logger.warn({ error }, 'Failed to revalue the holding value cache after a price write');
      return 0;
    }
  }

  /**
   * A price for each token against `base`, asked of the providers. A token no
   * provider answers keeps its last reading against `base`, unless a person
   * typed that one, and nothing new is written for it; with neither it is
   * absent from the map. Nothing stored is read before the fetch: the hourly
   * run's previous rows are exactly an hour old, so a reuse window served them
   * back in place of a fetch (D-6).
   */
  async getTokenPrices(
    tokensToPrice: Token[],
    base: Token,
    timestamp: Date,
    /** Receives the pairs whose written price moved. A deduplicated concurrent call fills none. */
    changed?: PairAt[]
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (tokensToPrice.length === 0) return results;

    const tokenIds = tokensToPrice
      .map((t) => t.id)
      .sort()
      .join(',');
    const timestampMinute = Math.floor(timestamp.getTime() / (60 * 1000)) * 60 * 1000;
    const deduplicationKey = `getTokenPrices:${tokenIds}:${base.id}:${timestampMinute}`;

    const ongoingRequest = this.ongoingRequests.get(deduplicationKey);
    if (ongoingRequest) {
      logger.debug({ deduplicationKey }, 'Deduplicating concurrent getTokenPrices request');
      return await ongoingRequest;
    }

    const requestPromise = (async (): Promise<Map<string, string>> => {
      try {
        const tokensNeedingPrices = tokensToPrice.filter((token) => {
          if (token.id === base.id) {
            results.set(token.id, '1');
            return false;
          }
          return true;
        });

        if (tokensNeedingPrices.length === 0) return results;

        logger.info(
          { tokenCount: tokensNeedingPrices.length, baseCurrency: base.symbol },
          'Fetching prices from external providers'
        );

        // First pass — fetch all needed tokens in one batch, fanning
        // out per-provider inside routeAndFetch. Each provider has its
        // own rate limiter + circuit breaker; per-provider transient
        // errors are caught inside fetchFromAllProviders and surface
        // as failure rows rather than throwing.
        //
        // The previous incarnation slept 2/4/8 s between three full
        // retries of the whole batch on any retryable error — a
        // single CoinGecko 429 stalled every other token's pricing
        // for up to 14 s. We now retry ONLY the tokens that came
        // back missing or zero, once, with no sleep — providers'
        // own limiters pace the second pass.
        try {
          const freshPrices = await this.providerRouter.routeAndFetch(
            tokensNeedingPrices,
            base,
            timestamp,
            changed
          );
          // Provider router still uses '0' as an internal failure
          // sentinel; we intentionally do not store that into the
          // result map.
          for (const priceResult of freshPrices) {
            if (priceResult.price !== '0') {
              results.set(priceResult.tokenId, priceResult.price);
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn(
            { error: err.message, tokenCount: tokensNeedingPrices.length },
            'Provider batch threw — retrying once for tokens still missing'
          );
        }

        const stillMissing = tokensNeedingPrices.filter((t) => !results.has(t.id));
        if (stillMissing.length > 0 && stillMissing.length < tokensNeedingPrices.length) {
          try {
            const retryPrices = await this.providerRouter.routeAndFetch(
              stillMissing,
              base,
              timestamp,
              changed
            );
            for (const priceResult of retryPrices) {
              if (priceResult.price !== '0') {
                results.set(priceResult.tokenId, priceResult.price);
              }
            }
          } catch (error) {
            logger.warn(
              {
                error: error instanceof Error ? error.message : String(error),
                tokenCount: stillMissing.length,
              },
              'Per-token retry pass failed — falling back to the last readings'
            );
          }
        }

        const unanswered = tokensNeedingPrices.filter((t) => !results.has(t.id));
        if (unanswered.length > 0) {
          const lastReadings = await this.tokenPriceRepository.findLatestPricesForTokens(
            Array.from(new Set(unanswered.map((t) => t.id))),
            base.id
          );
          for (const token of unanswered) {
            const reading = lastReadings.get(token.id);
            if (reading && !reading.source?.startsWith('manual')) {
              results.set(token.id, reading.price);
            }
          }
        }

        return results;
      } finally {
        this.ongoingRequests.delete(deduplicationKey);
      }
    })();

    this.ongoingRequests.set(deduplicationKey, requestPromise);
    return requestPromise;
  }
}
