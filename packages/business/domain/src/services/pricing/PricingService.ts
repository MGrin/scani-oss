import type { Token } from '@scani/db/schema';
import { createComponentLogger, logger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { CurrencyConverter } from './CurrencyConverter';
import { PricingProviderRouter } from './PricingProviderRouter';

const pricingLogger = createComponentLogger('pricing');

export interface CachedPrice {
  price: string;
  timestamp: Date;
  source: string;
  baseTokenId: string;
}

/**
 * `source` stamped on a fiat price the price graph derived rather than
 * `token_prices` holding it outright. Exported because it is the string a
 * reader sees under a converted figure, and two surfaces already special-case
 * price provenance by prefix.
 */
export const PRICE_GRAPH_FIAT_SOURCE = 'price-graph';

/**
 * Top-level pricing orchestrator. Resolves cache hits, deduplicates
 * concurrent requests, and falls through to `PricingProviderRouter`
 * for upstream fetches plus `CurrencyConverter` for fiat-pair
 * conversion. Failures are translated by `PricingFailureCacher`
 * inside the router.
 */
@Service()
export class PricingService {
  private readonly LIVE_PRICE_WINDOW_MS = 60 * 60 * 1000;
  private readonly HISTORICAL_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000;

  private readonly ongoingRequests = new Map<string, Promise<Map<string, string>>>();

  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly providerRouter = Container.get(PricingProviderRouter);
  private readonly currencyConverter = Container.get(CurrencyConverter);

  /**
   * Resolve a single token's price in the requested base currency.
   * Returns `null` when:
   *   - the base currency is unknown,
   *   - no cached price exists and no provider returned one,
   *   - the cached price's source currency can't be converted to the
   *     requested base currency (Frankfurter / exchangerate-api miss).
   *
   * Callers MUST treat `null` as "no price"; never coerce to `'0'`.
   */
  async getTokenPrice(
    token: Token,
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<string | null> {
    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      pricingLogger.debug({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrice');
      return null;
    }

    if (token.id === baseCurrencyToken.id) {
      return '1';
    }

    const cached = await this.getCachedPrice(token.id, baseCurrencyToken.id, timestamp);

    if (cached && cached.price !== '0') {
      if (cached.baseTokenId !== baseCurrencyToken.id) {
        const cachedBaseCurrencyToken = await this.tokenRepository.findById(cached.baseTokenId);

        if (cachedBaseCurrencyToken) {
          pricingLogger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
              fromCurrency: cachedBaseCurrencyToken.symbol,
              toCurrency: baseCurrencyToken.symbol,
              originalPrice: cached.price,
            },
            'Converting cached price to requested base currency'
          );

          return await this.currencyConverter.convert(
            cached.price,
            cachedBaseCurrencyToken,
            baseCurrencyToken,
            timestamp
          );
        }
      }

      return cached.price;
    }

    const hasFailedFinnhubCache =
      cached && cached.price === '0' && cached.source?.includes('Finnhub');
    const hasFinnhubMetadata = this.tokenHasFinnhubMetadata(token);

    if (hasFailedFinnhubCache && hasFinnhubMetadata) {
      pricingLogger.debug(
        {
          tokenId: token.id,
          symbol: token.symbol,
          cachedSource: cached.source,
        },
        'Token has failed Finnhub cache but Finnhub metadata - forcing fresh fetch with Google Sheets fallback'
      );
    }

    const freshPrices = await this.providerRouter.routeAndFetch(
      [token],
      baseCurrencyToken,
      timestamp
    );

    const priceResult = freshPrices.find((p) => p.tokenId === token.id);
    // PricingProviderRouter still uses '0' as an internal failure
    // sentinel (separate cleanup). Treat it the same as a missing
    // price; never propagate it out of PricingService.
    let finalPrice: string | null =
      priceResult?.price && priceResult.price !== '0' ? priceResult.price : null;

    if (finalPrice === null) {
      const lastSuccessfulPrice = await this.getLastSuccessfulPrice(token.id, baseCurrencyToken.id);

      if (lastSuccessfulPrice) {
        finalPrice = await this.convertCachedPriceIfNeeded(
          lastSuccessfulPrice,
          baseCurrencyToken.id,
          timestamp,
          undefined,
          baseCurrencyToken
        );

        pricingLogger.info(
          {
            tokenId: token.id,
            symbol: token.symbol,
            fallbackPrice: finalPrice,
            fallbackSource: lastSuccessfulPrice.source,
            originalTimestamp: lastSuccessfulPrice.timestamp,
          },
          'Using last successful price as fallback after all providers failed'
        );
      } else if (hasFinnhubMetadata) {
        logger.warn(
          { tokenId: token.id, symbol: token.symbol },
          'Token with Finnhub metadata still has no price after fresh fetch - check Google Sheets configuration'
        );
      }
    }

    return finalPrice;
  }

  // Ask for a price for `tokenId` against `baseCurrencySymbol` and return the
  // latest stored metadata, so callers (e.g. UpdateHoldingPriceUseCase) don't
  // re-query the repository themselves.
  //
  // Despite the name it does NOT guarantee a network call: `getTokenPrice`
  // serves anything inside `LIVE_PRICE_WINDOW_MS` from `token_prices` without
  // touching a provider, which is the right behaviour — a manual refresh must
  // not be a way to spend the hourly rate-limit budget on a price that is
  // already current.
  //
  // What it owes the caller is the DIFFERENCE. "Refresh price" reported a
  // green "BTC price refreshed" over a line that still read `25m ago`, because
  // the only signal it had was `success: true`, which meant "a price came
  // back" (SC-148). So the stored row is read once before and once after: the
  // clock is Postgres's on both sides, which is what makes the comparison
  // exact rather than a guess about how long a fetch should take.
  async fetchAndStoreFreshPrice(
    tokenId: string,
    baseCurrencySymbol: string,
    timestamp?: Date
  ): Promise<{
    price: string | null;
    source: string;
    timestamp: Date;
    /** False when the price returned is the one that was already stored. */
    fetched: boolean;
  }> {
    const now = timestamp ?? new Date();
    const token = await this.tokenRepository.findById(tokenId);
    if (!token) {
      throw new Error(`Token not found: ${tokenId}`);
    }

    // Resolved before the price call rather than after, so an unknown base
    // currency fails without first spending a provider request on it.
    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      throw new Error(`Base currency token not found: ${baseCurrencySymbol}`);
    }

    const before = await this.tokenPriceRepository.findLatestPrice(token.id, baseCurrencyToken.id);
    const price = await this.getTokenPrice(token, baseCurrencySymbol, now);
    const metadata = await this.tokenPriceRepository.findLatestPrice(
      token.id,
      baseCurrencyToken.id
    );

    const fetched =
      metadata !== null &&
      (before === null || metadata.timestamp.getTime() > before.timestamp.getTime());

    return {
      price,
      source: metadata?.source ?? 'unknown',
      timestamp: metadata?.timestamp ?? now,
      fetched,
    };
  }

  async getTokenPrices(
    tokensToPrice: Token[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (tokensToPrice.length === 0) return results;

    const tokenIds = tokensToPrice
      .map((t) => t.id)
      .sort()
      .join(',');
    const timestampMinute = Math.floor(timestamp.getTime() / (60 * 1000)) * 60 * 1000;
    const deduplicationKey = `getTokenPrices:${tokenIds}:${baseCurrencySymbol}:${timestampMinute}`;

    const ongoingRequest = this.ongoingRequests.get(deduplicationKey);
    if (ongoingRequest) {
      logger.debug({ deduplicationKey }, 'Deduplicating concurrent getTokenPrices request');
      return await ongoingRequest;
    }

    const requestPromise = (async (): Promise<Map<string, string>> => {
      try {
        const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
        if (!baseCurrencyToken) {
          // Same map-invariant as getCachedTokenPrices: present = priced.
          // Unknown base currency → no token can be priced → empty map.
          logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrices');
          return results;
        }

        const tokensToProcess = tokensToPrice.filter((token) => {
          if (token.id === baseCurrencyToken.id) {
            results.set(token.id, '1');
            return false;
          }
          return true;
        });

        if (tokensToProcess.length === 0) return results;

        const cachedPrices = await this.getBatchCachedPrices(
          tokensToProcess.map((t) => t.id),
          baseCurrencyToken.id,
          timestamp
        );

        const uniqueBaseCurrencyIds = new Set<string>();
        for (const cached of cachedPrices.values()) {
          if (cached.baseTokenId !== baseCurrencyToken.id) {
            uniqueBaseCurrencyIds.add(cached.baseTokenId);
          }
        }

        const baseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
        if (uniqueBaseCurrencyIds.size > 0) {
          const baseCurrencyTokens = await this.tokenRepository.findByIds(
            Array.from(uniqueBaseCurrencyIds)
          );
          for (const token of baseCurrencyTokens) {
            baseCurrencyTokensMap.set(token.id, token);
          }
        }

        const tokensNeedingPrices: Token[] = [];

        const tokensNeedingConversion: Array<{
          token: Token;
          cachedPrice: string;
          fromCurrency: Token;
        }> = [];

        for (const token of tokensToProcess) {
          const cached = cachedPrices.get(token.id);
          if (cached) {
            if (cached.baseTokenId !== baseCurrencyToken.id) {
              const cachedBaseCurrencyToken = baseCurrencyTokensMap.get(cached.baseTokenId);

              if (cachedBaseCurrencyToken) {
                tokensNeedingConversion.push({
                  token,
                  cachedPrice: cached.price,
                  fromCurrency: cachedBaseCurrencyToken,
                });
                continue;
              }
            }

            results.set(token.id, cached.price);
          } else {
            tokensNeedingPrices.push(token);
          }
        }

        if (tokensNeedingConversion.length > 0) {
          pricingLogger.debug(
            {
              count: tokensNeedingConversion.length,
              toCurrency: baseCurrencyToken.symbol,
            },
            'Batch converting cached prices to requested base currency'
          );

          const conversionPromises = tokensNeedingConversion.map(
            async ({ token, cachedPrice, fromCurrency }) => {
              const convertedPrice = await this.currencyConverter.convert(
                cachedPrice,
                fromCurrency,
                baseCurrencyToken,
                timestamp
              );
              return { tokenId: token.id, convertedPrice };
            }
          );

          const conversionResults = await Promise.all(conversionPromises);
          for (const { tokenId, convertedPrice } of conversionResults) {
            if (convertedPrice !== null) {
              results.set(tokenId, convertedPrice);
            }
          }
        }

        if (tokensNeedingPrices.length > 0) {
          logger.info(
            {
              tokenCount: tokensNeedingPrices.length,
              cachedCount: tokensToProcess.length - tokensNeedingPrices.length,
              baseCurrency: baseCurrencySymbol,
            },
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
              baseCurrencyToken,
              timestamp
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
                baseCurrencyToken,
                timestamp
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
                'Per-token retry pass failed — falling back to cached prices'
              );
            }
          }

          const tokensStillNeedingPrice = tokensNeedingPrices.filter((t) => !results.has(t.id));

          if (tokensStillNeedingPrice.length > 0) {
            const uniqueTokenIds = Array.from(new Set(tokensStillNeedingPrice.map((t) => t.id)));

            // Any-base lookup: see the rationale on
            // `getBatchCachedPrices`. The stale-fallback branch below
            // already calls `convertCachedPriceIfNeeded` to translate
            // a non-base-currency price to the user's base.
            const fallbackPrices = await this.tokenPriceRepository.findLatestPricesForTokensAnyBase(
              uniqueTokenIds,
              baseCurrencyToken.id
            );

            const uniqueFallbackBaseCurrencyIds = new Set<string>();
            for (const price of fallbackPrices.values()) {
              if (price.baseTokenId !== baseCurrencyToken.id) {
                uniqueFallbackBaseCurrencyIds.add(price.baseTokenId);
              }
            }

            const fallbackBaseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
            if (uniqueFallbackBaseCurrencyIds.size > 0) {
              const fallbackBaseCurrencyTokens = await this.tokenRepository.findByIds(
                Array.from(uniqueFallbackBaseCurrencyIds)
              );
              for (const token of fallbackBaseCurrencyTokens) {
                fallbackBaseCurrencyTokensMap.set(token.id, token);
              }
            }

            for (const token of tokensStillNeedingPrice) {
              const latestPrice = fallbackPrices.get(token.id);

              if (
                latestPrice &&
                latestPrice.price !== '0' &&
                !latestPrice.source?.startsWith('manual')
              ) {
                const price = parseFloat(latestPrice.price);
                if (!Number.isNaN(price) && price > 0) {
                  const lastSuccessfulPrice = {
                    price: latestPrice.price,
                    timestamp: latestPrice.timestamp,
                    source: `${latestPrice.source}_stale_fallback`,
                    baseTokenId: latestPrice.baseTokenId,
                  };

                  const fallbackPrice = await this.convertCachedPriceIfNeeded(
                    lastSuccessfulPrice,
                    baseCurrencyToken.id,
                    timestamp,
                    fallbackBaseCurrencyTokensMap,
                    baseCurrencyToken
                  );

                  if (fallbackPrice !== null) {
                    results.set(token.id, fallbackPrice);
                    pricingLogger.debug(
                      {
                        tokenId: token.id,
                        symbol: token.symbol,
                        fallbackPrice,
                        fallbackSource: lastSuccessfulPrice.source,
                        originalTimestamp: lastSuccessfulPrice.timestamp,
                      },
                      'Using last successful price as fallback in batch operation after all providers failed'
                    );
                  }
                }
              }

              // No fresh provider price, no usable stale fallback, or
              // the stale-fallback conversion failed. Omit the token
              // from `results` — caller treats absent keys as null.
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

  /**
   * Resolve cached prices for a batch of tokens, converted to the
   * requested base currency.
   *
   * Map invariant: a key is PRESENT only if the price could be resolved
   * AND converted. Unpriceable tokens (no cache, no stale fallback) and
   * unconvertable tokens (forex rate missing for the pair) are OMITTED
   * from the map. Callers MUST distinguish "priced" from "unpriceable"
   * via `.has(id)`; do NOT fall back to `'0'` — that's the silent-zero
   * bug that zeroed every dashboard after a base-currency switch.
   *
   * Cache-cold currency pairs are warmed up-front via
   * `CurrencyConverter.prewarmRates` (one live exchangerate-api call
   * per pair, deduplicated and rate-limited). Per-token conversions
   * then run cache-only and resolve from memory.
   */
  async getCachedTokenPrices(
    tokensToPrice: Token[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (tokensToPrice.length === 0) return results;

    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      // Unknown base currency: nothing can be priced. Return empty map;
      // callers see absent keys and treat the holdings as unpriceable.
      logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getCachedTokenPrices');
      return results;
    }

    const tokensToProcess = tokensToPrice.filter((token) => {
      if (token.id === baseCurrencyToken.id) {
        results.set(token.id, '1');
        return false;
      }
      return true;
    });

    if (tokensToProcess.length === 0) return results;

    const cachedPrices = await this.getBatchCachedPrices(
      tokensToProcess.map((t) => t.id),
      baseCurrencyToken.id,
      timestamp
    );

    const uniqueBaseCurrencyIds = new Set<string>();
    for (const cached of cachedPrices.values()) {
      if (cached.baseTokenId !== baseCurrencyToken.id) {
        uniqueBaseCurrencyIds.add(cached.baseTokenId);
      }
    }

    const baseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
    if (uniqueBaseCurrencyIds.size > 0) {
      const baseCurrencyTokens = await this.tokenRepository.findByIds(
        Array.from(uniqueBaseCurrencyIds)
      );
      for (const token of baseCurrencyTokens) {
        baseCurrencyTokensMap.set(token.id, token);
      }
    }

    // A fiat token's price in the user's base currency IS an exchange rate,
    // and `token_prices` is not where that rate lives for every currency.
    // `forex-backfill` quotes every edge against the hub — `GBP -> USD`,
    // `EUR -> USD` — so USD is never itself the priced token, and a USD cash
    // balance is unpriceable for anyone whose base is not USD (SC-505).
    //
    // The graph already answers this: it inverts the `GBP -> USD` row and
    // returns `USD -> GBP`. Ask it, rather than having forex-backfill write
    // rows for a fact that is derivable from the rows it already writes —
    // n² pairs of stored data that can disagree with each other.
    //
    // Placed ahead of the stale and sibling fallbacks deliberately. Both of
    // those would fire for a fiat token too, and both are worse answers: in
    // production the only `token_id = USD` row is a three-month-old
    // `USD -> IDR` quote, which the stale path would convert twice and
    // present as today's rate.
    for (const [tokenId, rate] of (
      await this.resolveFiatRatesToBase(
        tokensToProcess.filter((t) => !cachedPrices.has(t.id)),
        baseCurrencyToken,
        timestamp
      )
    ).entries()) {
      cachedPrices.set(tokenId, rate);
    }

    const tokensNeedingFallback = tokensToProcess.filter((t) => !cachedPrices.has(t.id));
    const fallbackPrices = new Map<string, CachedPrice>();

    if (tokensNeedingFallback.length > 0) {
      const uniqueTokenIds = Array.from(new Set(tokensNeedingFallback.map((t) => t.id)));

      // Any-base lookup so a USD-priced holding has a fallback when
      // the user's base is EUR (or anything else). The downstream
      // `tokensNeedingFallbackConversion` branch translates these via
      // CurrencyConverter when `baseTokenId !== baseCurrencyToken.id`.
      const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokensAnyBase(
        uniqueTokenIds,
        baseCurrencyToken.id
      );

      for (const [tokenId, price] of latestPrices.entries()) {
        if (price.price !== '0' && !price.source?.startsWith('manual')) {
          const priceValue = parseFloat(price.price);
          if (!Number.isNaN(priceValue) && priceValue > 0) {
            fallbackPrices.set(tokenId, {
              price: price.price,
              timestamp: price.timestamp,
              source: `${price.source}_stale_fallback`,
              baseTokenId: price.baseTokenId,
            });
          }
        }
      }
    }

    // Last resort: borrow from a SIBLING ROW OF THE SAME ASSET (SC-198).
    //
    // One asset is routinely spread across several token rows — USDC is
    // held on `evm:1`, `evm:8453` and a `(generic)` row, and only some of
    // them accumulate prices, so a holding on the wrong row shows no value
    // while an identical holding beside it shows one.
    //
    // Keyed on `coingecko.id` and NEVER on the symbol; `findPricingSiblings`
    // carries the two reasons. The short version is that a symbol-keyed
    // version would price a DogTrump holding as Official Trump, and would
    // hand a homoglyph `UЅDС` row the real USDC price.
    //
    // A borrowed price is marked `_sibling_fallback` in `source` so it is
    // traceable to a row the user does not hold. It is still a price we
    // stand behind — same asset, same market — but it did not come from
    // the row it is displayed against, and a number whose provenance is
    // invisible is how the manual-price and downsample defects happened.
    const stillUnpriced = tokensToProcess.filter(
      (t) => !cachedPrices.has(t.id) && !fallbackPrices.has(t.id)
    );
    if (stillUnpriced.length > 0) {
      const siblingsByToken = await this.tokenRepository.findPricingSiblings(
        stillUnpriced.map((t) => t.id)
      );
      const donorIds = Array.from(new Set(Array.from(siblingsByToken.values()).flat()));
      if (donorIds.length > 0) {
        const donorPrices = await this.tokenPriceRepository.findLatestPricesForTokensAnyBase(
          donorIds,
          baseCurrencyToken.id
        );
        for (const token of stillUnpriced) {
          const siblings = siblingsByToken.get(token.id);
          if (!siblings) continue;
          // Newest across the donors — a sibling that stopped being priced
          // months ago is not a better answer than one priced today.
          let best: { price: string; timestamp: Date; baseTokenId: string } | null = null;
          for (const siblingId of siblings) {
            const candidate = donorPrices.get(siblingId);
            if (!candidate) continue;
            if (candidate.price === '0' || candidate.source?.startsWith('manual')) continue;
            const value = parseFloat(candidate.price);
            if (Number.isNaN(value) || value <= 0) continue;
            if (!best || candidate.timestamp > best.timestamp) {
              best = {
                price: candidate.price,
                timestamp: candidate.timestamp,
                baseTokenId: candidate.baseTokenId,
              };
            }
          }
          if (best) {
            fallbackPrices.set(token.id, {
              price: best.price,
              timestamp: best.timestamp,
              source: 'sibling_fallback',
              baseTokenId: best.baseTokenId,
            });
          }
        }
      }
    }

    const uniqueFallbackBaseCurrencyIds = new Set<string>();
    for (const fallbackPrice of fallbackPrices.values()) {
      if (fallbackPrice.baseTokenId !== baseCurrencyToken.id) {
        uniqueFallbackBaseCurrencyIds.add(fallbackPrice.baseTokenId);
      }
    }

    const fallbackBaseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
    if (uniqueFallbackBaseCurrencyIds.size > 0) {
      const fallbackBaseCurrencyTokens = await this.tokenRepository.findByIds(
        Array.from(uniqueFallbackBaseCurrencyIds)
      );
      for (const token of fallbackBaseCurrencyTokens) {
        fallbackBaseCurrencyTokensMap.set(token.id, token);
      }
    }

    const tokensNeedingConversion: Array<{
      tokenId: string;
      price: string;
      fromCurrency: Token;
    }> = [];
    const tokensNeedingFallbackConversion: Array<{
      tokenId: string;
      fallbackPrice: CachedPrice;
    }> = [];

    for (const token of tokensToProcess) {
      const cached = cachedPrices.get(token.id);
      if (cached) {
        if (cached.baseTokenId !== baseCurrencyToken.id) {
          const cachedBaseCurrencyToken = baseCurrencyTokensMap.get(cached.baseTokenId);

          if (cachedBaseCurrencyToken) {
            tokensNeedingConversion.push({
              tokenId: token.id,
              price: cached.price,
              fromCurrency: cachedBaseCurrencyToken,
            });
            continue;
          }
        }

        results.set(token.id, cached.price);
      } else {
        const lastSuccessfulPrice = fallbackPrices.get(token.id);

        if (lastSuccessfulPrice) {
          tokensNeedingFallbackConversion.push({
            tokenId: token.id,
            fallbackPrice: lastSuccessfulPrice,
          });
        }
        // No cached price, no stale fallback: token is unpriceable.
        // Omit from results — caller distinguishes via `.has(id)`.
      }
    }

    // Pre-warm conversion-rate cache for every unique (from → user-base)
    // pair we're about to convert. `prewarmRates` calls the live forex
    // API once per pair (deduplicated, rate-limited) so the per-token
    // `convert` loop below resolves out of the in-memory cache. Without
    // this warm-up, a base-currency switch leaves the cache cold and
    // every conversion returns null → silent unpriced holdings.
    const pairsToWarm: Array<{ from: Token; to: Token }> = [];
    for (const { fromCurrency } of tokensNeedingConversion) {
      if (fromCurrency.id !== baseCurrencyToken.id) {
        pairsToWarm.push({ from: fromCurrency, to: baseCurrencyToken });
      }
    }
    for (const { fallbackPrice } of tokensNeedingFallbackConversion) {
      if (fallbackPrice.baseTokenId !== baseCurrencyToken.id) {
        const fallbackBaseCurrency = fallbackBaseCurrencyTokensMap.get(fallbackPrice.baseTokenId);
        if (fallbackBaseCurrency) {
          pairsToWarm.push({
            from: fallbackBaseCurrency,
            to: baseCurrencyToken,
          });
        }
      }
    }

    if (pairsToWarm.length > 0) {
      pricingLogger.debug(
        {
          pairs: pairsToWarm.map((p) => `${p.from.symbol}->${p.to.symbol}`),
        },
        'Pre-warming conversion rate cache for unique currency pairs'
      );
      await this.currencyConverter.prewarmRates(pairsToWarm, timestamp);
    }

    // Each promise resolves to a price (rates are warm, so conversion
    // is a memory hit) OR `null` when even the warmed cache couldn't
    // produce a rate (the pair is truly unsupported — Frankfurter and
    // exchangerate-api both miss it). Null results are omitted from the
    // map below; callers see absence as "unpriceable".
    const conversionPromises: Promise<{ tokenId: string; price: string | null }>[] = [];

    for (const { tokenId, price, fromCurrency } of tokensNeedingConversion) {
      conversionPromises.push(
        this.currencyConverter
          .convert(price, fromCurrency, baseCurrencyToken, timestamp, true)
          .then((convertedPrice) => ({ tokenId, price: convertedPrice }))
      );
    }

    for (const { tokenId, fallbackPrice } of tokensNeedingFallbackConversion) {
      conversionPromises.push(
        this.convertCachedPriceIfNeeded(
          fallbackPrice,
          baseCurrencyToken.id,
          timestamp,
          fallbackBaseCurrencyTokensMap,
          baseCurrencyToken
        ).then((convertedPrice) => ({ tokenId, price: convertedPrice }))
      );
    }

    if (conversionPromises.length > 0) {
      pricingLogger.debug(
        { count: conversionPromises.length },
        'Executing parallel currency conversions in cached-only pricing'
      );

      const conversionResults = await Promise.all(conversionPromises);
      for (const { tokenId, price } of conversionResults) {
        if (price !== null) {
          results.set(tokenId, price);
        }
      }
    }

    return results;
  }

  async preWarmCurrencyConversionCache(): Promise<void> {
    await this.currencyConverter.preWarm();
  }

  async canTokenBePriced(
    tokenData: {
      symbol: string;
      name: string;
      metadata: Record<string, unknown>;
      typeCode: string;
    },
    baseCurrency = 'USD'
  ): Promise<{ canBePriced: boolean; provider?: string; reason?: string }> {
    return await this.providerRouter.canTokenBePriced(tokenData, baseCurrency);
  }

  private async getCachedPrice(
    tokenId: string,
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<CachedPrice | null> {
    const isLive = this.isLivePrice(timestamp);
    const maxAge = isLive ? this.LIVE_PRICE_WINDOW_MS : this.HISTORICAL_PRICE_WINDOW_MS;

    const price = await this.tokenPriceRepository.findPriceAtTimestamp(
      tokenId,
      baseCurrencyId,
      timestamp,
      maxAge
    );

    if (price) {
      return {
        price: price.price,
        timestamp: price.timestamp,
        source: price.source || 'cached',
        baseTokenId: price.baseTokenId,
      };
    }

    // Manual prices for private tokens don't expire and apply across
    // base-currency boundaries; fall back to the latest manual price
    // for any base currency and let the caller's conversion path do
    // the work.
    const latestPrice = await this.tokenPriceRepository.findLatestPrice(tokenId, baseCurrencyId);

    if (latestPrice?.source?.startsWith('manual')) {
      pricingLogger.debug(
        {
          tokenId,
          requestedBaseCurrency: baseCurrencyId,
          priceBaseCurrency: latestPrice.baseTokenId,
          source: latestPrice.source,
          timestamp: latestPrice.timestamp,
        },
        'Found manual price for private token'
      );
      return {
        price: latestPrice.price,
        timestamp: latestPrice.timestamp,
        source: latestPrice.source,
        baseTokenId: latestPrice.baseTokenId,
      };
    }

    const manualAnyBase = await this.tokenPriceRepository.findLatestManualPricesForTokensAnyBase([
      tokenId,
    ]);
    const manual = manualAnyBase.get(tokenId);
    if (manual) {
      pricingLogger.debug(
        {
          tokenId,
          requestedBaseCurrency: baseCurrencyId,
          priceBaseCurrency: manual.baseTokenId,
          source: manual.source,
          timestamp: manual.timestamp,
        },
        'Found manual price in alternate base — will be converted to requested currency'
      );
      return {
        price: manual.price,
        timestamp: manual.timestamp,
        source: manual.source ?? 'manual',
        baseTokenId: manual.baseTokenId,
      };
    }

    return null;
  }

  private async getLastSuccessfulPrice(
    tokenId: string,
    baseCurrencyId: string
  ): Promise<CachedPrice | null> {
    const latestPrice = await this.tokenPriceRepository.findLatestPrice(tokenId, baseCurrencyId);

    if (latestPrice && latestPrice.price !== '0' && !latestPrice.source?.startsWith('manual')) {
      const price = parseFloat(latestPrice.price);
      if (!Number.isNaN(price) && price > 0) {
        return {
          price: latestPrice.price,
          timestamp: latestPrice.timestamp,
          source: `${latestPrice.source}_stale_fallback`,
          baseTokenId: latestPrice.baseTokenId,
        };
      }
    }

    return null;
  }

  private async convertCachedPriceIfNeeded(
    cachedPrice: CachedPrice,
    targetBaseCurrencyId: string,
    timestamp: Date,
    baseCurrencyTokensMap?: Map<string, Token>,
    targetBaseCurrencyToken?: Token
  ): Promise<string | null> {
    if (cachedPrice.baseTokenId === targetBaseCurrencyId) {
      return cachedPrice.price;
    }

    const cachedBaseCurrencyToken =
      baseCurrencyTokensMap?.get(cachedPrice.baseTokenId) ||
      (await this.tokenRepository.findById(cachedPrice.baseTokenId));

    if (cachedBaseCurrencyToken) {
      const targetToken =
        targetBaseCurrencyToken || (await this.tokenRepository.findById(targetBaseCurrencyId));
      if (targetToken) {
        return await this.currencyConverter.convert(
          cachedPrice.price,
          cachedBaseCurrencyToken,
          targetToken,
          timestamp
        );
      }
    }

    return cachedPrice.price;
  }

  /**
   * The exchange rate to `baseCurrencyToken` for each token in `tokens` that
   * is a fiat currency, expressed as a price of one unit — which is what a
   * cash holding is valued by.
   *
   * Non-fiat tokens are skipped: a crypto or equity price is a market quote
   * that has to come from a provider, not something the FX graph can derive.
   * A fiat pair the graph cannot route is absent from the map, on the same
   * "absent means unpriceable, never zero" contract as everything else here.
   *
   * `getStoredRateDetail` rather than `getRate`: this serves a user read, so
   * it must never make the caller wait on the exchangerate-api limiter, and a
   * rate from yesterday dated honestly beats no rate at all (SC-222).
   */
  async resolveFiatRatesToBase(
    tokens: readonly Token[],
    baseCurrencyToken: Token,
    timestamp: Date
  ): Promise<Map<string, CachedPrice>> {
    const resolved = new Map<string, CachedPrice>();
    if (tokens.length === 0) return resolved;

    const fiatType = await this.tokenTypeRepository.findByCode('fiat');
    if (!fiatType) return resolved;

    const fiat = tokens.filter((t) => t.typeId === fiatType.id && t.id !== baseCurrencyToken.id);
    if (fiat.length === 0) return resolved;

    const rates = await Promise.all(
      fiat.map(async (token) => {
        const detail = await this.currencyConverter.getStoredRateDetail(
          token,
          baseCurrencyToken,
          timestamp
        );
        return { token, detail };
      })
    );

    for (const { token, detail } of rates) {
      if (!detail) continue;
      resolved.set(token.id, {
        price: detail.rate,
        timestamp: detail.asOf,
        source: PRICE_GRAPH_FIAT_SOURCE,
        baseTokenId: baseCurrencyToken.id,
      });
    }

    if (resolved.size > 0) {
      pricingLogger.debug(
        { count: resolved.size, baseCurrency: baseCurrencyToken.symbol },
        'Resolved fiat holdings through the price graph'
      );
    }

    return resolved;
  }

  private async getBatchCachedPrices(
    tokenIds: string[],
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<Map<string, CachedPrice>> {
    const results = new Map<string, CachedPrice>();

    if (tokenIds.length === 0) return results;

    const uniqueTokenIds = Array.from(new Set(tokenIds));

    // Look up the latest price per token across ALL base currencies,
    // tie-breaking toward the requested one. The strict-base lookup
    // we used here previously returned nothing when the user's base
    // currency was different from the base every cached price was
    // stored against (every USD-priced holding for an EUR user → empty
    // map → dashboard silently zeroed). The downstream conversion
    // branch reconciles `baseTokenId !== baseCurrencyToken.id` via
    // CurrencyConverter.
    const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokensAnyBase(
      uniqueTokenIds,
      baseCurrencyId
    );

    const isLive = this.isLivePrice(timestamp);
    const maxAge = isLive ? this.LIVE_PRICE_WINDOW_MS : this.HISTORICAL_PRICE_WINDOW_MS;
    const minTimestamp = new Date(timestamp.getTime() - maxAge);

    for (const [tokenId, price] of latestPrices.entries()) {
      if (price.timestamp >= minTimestamp || price.source?.startsWith('manual')) {
        if (price.source?.startsWith('manual')) {
          pricingLogger.debug(
            {
              tokenId,
              source: price.source,
              timestamp: price.timestamp,
            },
            'Using manual price in batch without time restriction'
          );
        }
        results.set(tokenId, {
          price: price.price,
          timestamp: price.timestamp,
          source: price.source || 'cached',
          baseTokenId: price.baseTokenId,
        });
      }
    }

    // For tokens without a price in the requested base currency, look
    // up the latest manual price in ANY base currency. Custom tokens
    // may be priced in EUR / GBP / etc. — the caller's conversion
    // path will convert to the requested base when
    // `baseTokenId !== baseCurrencyToken.id`.
    const missingIds = uniqueTokenIds.filter((id) => !results.has(id));
    if (missingIds.length > 0) {
      const manualAnyBase =
        await this.tokenPriceRepository.findLatestManualPricesForTokensAnyBase(missingIds);
      for (const [tokenId, price] of manualAnyBase.entries()) {
        pricingLogger.debug(
          {
            tokenId,
            requestedBaseCurrency: baseCurrencyId,
            priceBaseCurrency: price.baseTokenId,
            source: price.source,
          },
          'Using manual price in alternate base — caller will convert'
        );
        results.set(tokenId, {
          price: price.price,
          timestamp: price.timestamp,
          source: price.source ?? 'manual',
          baseTokenId: price.baseTokenId,
        });
      }
    }

    return results;
  }

  private isLivePrice(timestamp: Date): boolean {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    return diffMs < 2 * 60 * 60 * 1000;
  }

  private tokenHasFinnhubMetadata(token: Token): boolean {
    const metadata = (token.providerMetadata ?? {}) as { finnhub?: { symbol?: string } };
    return !!metadata.finnhub?.symbol;
  }
}
