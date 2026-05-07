import type { Token } from '@scani/db/schema';
import { createComponentLogger, logger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { CurrencyConverter } from './CurrencyConverter';
import { PricingProviderRouter } from './PricingProviderRouter';

const pricingLogger = createComponentLogger('pricing');

interface CachedPrice {
  price: string;
  timestamp: Date;
  source: string;
  baseTokenId: string;
}

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
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly providerRouter = Container.get(PricingProviderRouter);
  private readonly currencyConverter = Container.get(CurrencyConverter);

  async getTokenPrice(token: Token, baseCurrencySymbol: string, timestamp: Date): Promise<string> {
    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      pricingLogger.debug({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrice');
      return '0';
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
            cachedBaseCurrencyToken.symbol,
            baseCurrencyToken.symbol,
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
    let finalPrice = priceResult?.price || '0';

    if (finalPrice === '0') {
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

  // Fetch a fresh price for `tokenId` against `baseCurrencySymbol`,
  // persist it via the provider router (already handled inside
  // `getTokenPrice`), and return the latest stored metadata so callers
  // (e.g. UpdateHoldingPriceUseCase) don't need to re-query the
  // repository themselves.
  async fetchAndStoreFreshPrice(
    tokenId: string,
    baseCurrencySymbol: string,
    timestamp?: Date
  ): Promise<{ price: string; source: string; timestamp: Date }> {
    const now = timestamp ?? new Date();
    const token = await this.tokenRepository.findById(tokenId);
    if (!token) {
      throw new Error(`Token not found: ${tokenId}`);
    }

    const price = await this.getTokenPrice(token, baseCurrencySymbol, now);

    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      throw new Error(`Base currency token not found: ${baseCurrencySymbol}`);
    }

    const metadata = await this.tokenPriceRepository.findLatestPrice(
      token.id,
      baseCurrencyToken.id
    );

    return {
      price,
      source: metadata?.source ?? 'unknown',
      timestamp: metadata?.timestamp ?? now,
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
          logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrices');
          for (const token of tokensToPrice) {
            results.set(token.id, '0');
          }
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
          fromCurrency: string;
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
                  fromCurrency: cachedBaseCurrencyToken.symbol,
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
                baseCurrencyToken.symbol,
                timestamp
              );
              return { tokenId: token.id, convertedPrice };
            }
          );

          const conversionResults = await Promise.all(conversionPromises);
          for (const { tokenId, convertedPrice } of conversionResults) {
            results.set(tokenId, convertedPrice);
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
            for (const priceResult of freshPrices) {
              results.set(priceResult.tokenId, priceResult.price);
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.warn(
              { error: err.message, tokenCount: tokensNeedingPrices.length },
              'Provider batch threw — retrying once for tokens still missing'
            );
          }

          const stillMissing = tokensNeedingPrices.filter(
            (t) => !results.has(t.id) || results.get(t.id) === '0'
          );
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

          const tokensStillNeedingPrice = tokensNeedingPrices.filter(
            (t) => !results.has(t.id) || results.get(t.id) === '0'
          );

          if (tokensStillNeedingPrice.length > 0) {
            const uniqueTokenIds = Array.from(new Set(tokensStillNeedingPrice.map((t) => t.id)));

            const fallbackPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
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
                  continue;
                }
              }

              results.set(token.id, '0');
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

  async getCachedTokenPrices(
    tokensToPrice: Token[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (tokensToPrice.length === 0) return results;

    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getCachedTokenPrices');
      for (const token of tokensToPrice) {
        results.set(token.id, '0');
      }
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

    const tokensNeedingFallback = tokensToProcess.filter((t) => !cachedPrices.has(t.id));
    const fallbackPrices = new Map<string, CachedPrice>();

    if (tokensNeedingFallback.length > 0) {
      const uniqueTokenIds = Array.from(new Set(tokensNeedingFallback.map((t) => t.id)));

      const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
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
      fromCurrency: string;
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
              fromCurrency: cachedBaseCurrencyToken.symbol,
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
        } else {
          results.set(token.id, '0');
        }
      }
    }

    // Pre-warm conversion-rate cache for all unique pairs in cache-only
    // mode so each per-token conversion below is a memory hit.
    const uniqueFromCurrencies = new Set<string>();
    for (const { fromCurrency } of tokensNeedingConversion) {
      if (fromCurrency !== baseCurrencyToken.symbol) {
        uniqueFromCurrencies.add(fromCurrency);
      }
    }
    for (const { fallbackPrice } of tokensNeedingFallbackConversion) {
      if (fallbackPrice.baseTokenId !== baseCurrencyToken.id) {
        const fallbackBaseCurrency = fallbackBaseCurrencyTokensMap.get(fallbackPrice.baseTokenId);
        if (fallbackBaseCurrency) {
          uniqueFromCurrencies.add(fallbackBaseCurrency.symbol);
        }
      }
    }

    if (uniqueFromCurrencies.size > 0) {
      pricingLogger.debug(
        {
          currencies: Array.from(uniqueFromCurrencies),
          toCurrency: baseCurrencyToken.symbol,
        },
        'Pre-warming conversion rate cache for unique currency pairs'
      );

      await Promise.all(
        Array.from(uniqueFromCurrencies).map((fromCurrency) =>
          this.currencyConverter.getRate(fromCurrency, baseCurrencyToken.symbol, timestamp, true)
        )
      );
    }

    const conversionPromises: Promise<{ tokenId: string; price: string }>[] = [];

    for (const { tokenId, price, fromCurrency } of tokensNeedingConversion) {
      conversionPromises.push(
        this.currencyConverter
          .convert(price, fromCurrency, baseCurrencyToken.symbol, timestamp, true)
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
        results.set(tokenId, price);
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
  ): Promise<string> {
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
          cachedBaseCurrencyToken.symbol,
          targetToken.symbol,
          timestamp
        );
      }
    }

    return cachedPrice.price;
  }

  private async getBatchCachedPrices(
    tokenIds: string[],
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<Map<string, CachedPrice>> {
    const results = new Map<string, CachedPrice>();

    if (tokenIds.length === 0) return results;

    const uniqueTokenIds = Array.from(new Set(tokenIds));

    const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
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
