/**
 * UpdateTokenPricesUseCase
 *
 * Updates prices for all tokens that are currently held in at least one holding.
 * This use case is designed to be called by scheduled cron jobs.
 *
 * Responsibilities:
 * - Find all unique tokens that have active holdings
 * - Fetch fresh prices for those tokens from pricing providers
 * - Respect rate limits of external APIs
 * - Log progress and errors
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { emitEntityChange } from '@scani/realtime';
import { inArray } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../repositories/TokenRepository';
import { HoldingQueryService, PricingService, VaultService } from '../services';

const logger = createComponentLogger('use-case:update-token-prices');

export interface UpdateTokenPricesResult {
  /** Total number of unique tokens with holdings */
  tokensFound: number;
  /** Number of tokens successfully priced */
  tokensUpdated: number;
  /** Number of tokens that failed to price */
  tokensFailed: number;
  /**
   * Tokens deliberately not asked about, because they are inside an
   * unpriceable cooldown and have never had a single price row (SC-296).
   *
   * Counted apart from `tokensFailed` on purpose: "13 failed" and "13
   * suppressed on purpose" are different sentences, and only one of them is
   * something to look at.
   */
  tokensSuppressed: number;
  /** Errors encountered during update */
  errors: Array<{
    tokenId: string;
    tokenSymbol: string;
    error: string;
  }>;
  /** Duration of the operation in milliseconds */
  durationMs: number;
}

/**
 * Update Token Prices Use Case
 */
@Service()
export class UpdateTokenPricesUseCase {
  private readonly pricingService = Container.get(PricingService);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingQueryService = Container.get(HoldingQueryService);
  private readonly vaultService = Container.get(VaultService);

  async execute(baseCurrencySymbol = 'USD'): Promise<UpdateTokenPricesResult> {
    const startTime = Date.now();
    logger.info({ baseCurrencySymbol }, 'Starting token price update for all tokens with holdings');

    const errors: UpdateTokenPricesResult['errors'] = [];

    try {
      // Find all unique token IDs from holdings using service
      const uniqueTokenIds = await this.holdingQueryService.getDistinctTokenIds();

      if (uniqueTokenIds.length === 0) {
        logger.info('No tokens with holdings found');
        return {
          tokensFound: 0,
          tokensUpdated: 0,
          tokensFailed: 0,
          tokensSuppressed: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        };
      }

      logger.info(
        {
          tokenCount: uniqueTokenIds.length,
        },
        'Found tokens with holdings'
      );

      /**
       * Drop the tokens the nightly backfill has already established nobody
       * quotes (SC-296).
       *
       * Until now only `BackfillHistoricalPricesUseCase` honoured
       * `unpriceable_until`; this job re-asked every hour forever. On the
       * 19:00Z run that produced this ticket all 13 of its 13 failures were
       * tokens marked at 08:19Z the same day — ~312 provider calls a day,
       * known in advance to return nothing, against providers we rate-limit
       * and circuit-break precisely because their budget is finite.
       *
       * **The predicate is the conjunction, not the flag** — in cooldown AND
       * never had a `token_prices` row — because that is what every other
       * reader of this state already means by "unpriceable" (SC-146:
       * `findNeverPricedInCooldownTokenIds` is what the rollup, the holdings
       * list and the valuation consult). Filtering on the flag alone would
       * have made this job the only place in the codebase with its own
       * definition, and a token carrying a stale mark from before SC-232 —
       * when marks could still land on tokens that had prices — would be
       * dropped from pricing while being perfectly priceable.
       *
       * **Why this cannot suppress a newly-added holding.** A token reaches
       * the cooldown only if a provider answered *cleanly with nothing* over
       * at least 30 requested days, and the requested range starts at the
       * token's first transaction, so a holding added minutes ago has no such
       * range to fail. Beyond that, both the mark (SC-232) and this filter
       * require **zero** stored price rows — and a successful fetch here
       * writes one (`PricingProviderRouter` → `bulkUpsert`). So the first
       * time any price lands, the token stops being suppressible and stops
       * being markable, permanently and with no intervention.
       */
      const suppressedIds = await this.tokenRepository.findNeverPricedInCooldownTokenIds(
        uniqueTokenIds,
        new Date()
      );
      const priceableIds = uniqueTokenIds.filter((id) => !suppressedIds.has(id));

      if (suppressedIds.size > 0) {
        logger.info(
          { tokensSuppressed: suppressedIds.size, tokensFound: uniqueTokenIds.length },
          'Skipping tokens inside an unpriceable cooldown that have never been priced'
        );
      }

      // Fetch token details using batch query
      const tokens = await this.tokenRepository.findByIds(priceableIds);

      if (tokens.length === 0) {
        // Two different nothings, and they must not log the same (SC-296).
        // Every token suppressed is the cooldown working; no rows returned
        // for ids that ARE priceable is a fault. Before this split a fully
        // suppressed run would have reported `tokensFailed = tokensFound`
        // and warned — turning the fix into a louder version of the bug.
        const allSuppressed = priceableIds.length === 0;
        if (allSuppressed) {
          logger.info(
            {
              tokensFound: uniqueTokenIds.length,
              tokensSuppressed: suppressedIds.size,
              durationMs: Date.now() - startTime,
            },
            'Every held token is inside an unpriceable cooldown — nothing to ask'
          );
        } else {
          logger.warn('No valid tokens found');
        }
        return {
          tokensFound: uniqueTokenIds.length,
          tokensUpdated: 0,
          tokensFailed: allSuppressed ? 0 : priceableIds.length,
          tokensSuppressed: suppressedIds.size,
          errors: allSuppressed
            ? []
            : [
                {
                  tokenId: 'unknown',
                  tokenSymbol: 'unknown',
                  error: 'No valid tokens found in database',
                },
              ],
          durationMs: Date.now() - startTime,
        };
      }

      logger.info(
        {
          validTokenCount: tokens.length,
        },
        'Fetching prices for tokens'
      );

      // Fetch prices for all tokens (batched internally by PricingService)
      const timestamp = new Date();
      const prices = await this.pricingService.getTokenPrices(
        tokens,
        baseCurrencySymbol,
        timestamp
      );

      // Count successful and failed updates
      let tokensUpdated = 0;
      let tokensFailed = 0;

      for (const token of tokens) {
        const price = prices.get(token.id);
        if (price && price !== '0') {
          tokensUpdated++;
          logger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
              price,
            },
            'Token price updated'
          );
        } else {
          tokensFailed++;
          errors.push({
            tokenId: token.id,
            tokenSymbol: token.symbol,
            error: 'Failed to fetch price or price is zero',
          });
          logger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
            },
            'Failed to update token price'
          );
        }
      }

      const updatedTokenIds = tokens
        .filter((t) => {
          const price = prices.get(t.id);
          return price && price !== '0';
        })
        .map((t) => t.id);

      // Holdings touched by this price run — used both to recalculate
      // vaults and to notify the users who hold those tokens.
      let holdingsForUpdatedTokens: Array<{ id: string; tokenId: string; userId: string }> = [];
      if (updatedTokenIds.length > 0) {
        holdingsForUpdatedTokens = await db
          .select({
            id: schema.holdings.id,
            tokenId: schema.holdings.tokenId,
            userId: schema.holdings.userId,
          })
          .from(schema.holdings)
          .where(inArray(schema.holdings.tokenId, updatedTokenIds));
      }

      // Recalculate vaults for all tokens that had price updates (best-effort)
      try {
        if (holdingsForUpdatedTokens.length > 0) {
          // Group by tokenId
          const holdingsByToken = new Map<string, string[]>();
          for (const h of holdingsForUpdatedTokens) {
            const ids = holdingsByToken.get(h.tokenId);
            if (ids) {
              ids.push(h.id);
            } else {
              holdingsByToken.set(h.tokenId, [h.id]);
            }
          }

          // Bounded fan-out: each token's vault recalculation is
          // independent, so batch them instead of one-at-a-time.
          const VAULT_CONCURRENCY = 10;
          for (let i = 0; i < updatedTokenIds.length; i += VAULT_CONCURRENCY) {
            const batch = updatedTokenIds.slice(i, i + VAULT_CONCURRENCY);
            await Promise.all(
              batch.map((tokenId) => {
                const holdingIds = holdingsByToken.get(tokenId);
                if (holdingIds && holdingIds.length > 0) {
                  return this.vaultService.recalculateVaultsForToken(tokenId, holdingIds);
                }
                return Promise.resolve();
              })
            );
          }
        }
      } catch (vaultError) {
        logger.warn({ error: vaultError }, 'Failed to recalculate vaults after token price update');
      }

      // Notify every user holding a repriced token so their dashboard /
      // holdings views refresh — without this the hourly price refresh
      // is invisible until the next mutation or page remount. One
      // coalesced event per user keeps the broadcast bounded.
      try {
        const affectedUserIds = new Set(holdingsForUpdatedTokens.map((h) => h.userId));
        for (const affectedUserId of affectedUserIds) {
          emitEntityChange({
            entityType: 'holding',
            operationType: 'sync',
            userId: affectedUserId,
            data: { reason: 'price_refresh', tokensUpdated: updatedTokenIds.length },
          });
        }
      } catch (emitError) {
        logger.warn(
          { error: emitError },
          'Failed to emit price-refresh realtime events after token price update'
        );
      }

      const durationMs = Date.now() - startTime;

      // `warn` is reserved for tokens we ASKED about and did not get (SC-296).
      // The 19:00Z run that produced this ticket warned "13 failed" when the
      // truth was "13 suppressed on purpose" — a sentence that reads as a
      // provider problem and sent people looking for one. A suppressed token
      // is reported, at `info`, in its own field, and never inflates
      // `tokensFailed`.
      if (tokensFailed > 0) {
        logger.warn(
          {
            tokensFound: uniqueTokenIds.length,
            tokensAsked: tokens.length,
            tokensUpdated,
            tokensFailed,
            tokensSuppressed: suppressedIds.size,
            failedSymbols: errors.map((e) => e.tokenSymbol).slice(0, 20),
            durationMs,
          },
          'Token price update completed with failures'
        );
      } else {
        logger.info(
          {
            tokensFound: uniqueTokenIds.length,
            tokensAsked: tokens.length,
            tokensUpdated,
            tokensSuppressed: suppressedIds.size,
            durationMs,
          },
          suppressedIds.size > 0
            ? 'Token price update completed; every token asked about was priced'
            : 'Token price update completed'
        );
      }

      return {
        tokensFound: uniqueTokenIds.length,
        tokensUpdated,
        tokensSuppressed: suppressedIds.size,
        tokensFailed,
        errors,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs,
        },
        'Failed to update token prices'
      );

      throw error;
    }
  }
}
