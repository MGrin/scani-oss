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

import { inArray } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { TokenRepository } from '../repositories/TokenRepository';
import { HoldingService } from '../services/HoldingService';
import { PricingService } from '../services/PricingService';
import { VaultService } from '../services/VaultService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:update-token-prices');

export interface UpdateTokenPricesResult {
  /** Total number of unique tokens with holdings */
  tokensFound: number;
  /** Number of tokens successfully priced */
  tokensUpdated: number;
  /** Number of tokens that failed to price */
  tokensFailed: number;
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
  private readonly holdingService = Container.get(HoldingService);
  private readonly vaultService = Container.get(VaultService);

  async execute(baseCurrencySymbol = 'USD'): Promise<UpdateTokenPricesResult> {
    const startTime = Date.now();
    logger.info({ baseCurrencySymbol }, 'Starting token price update for all tokens with holdings');

    const errors: UpdateTokenPricesResult['errors'] = [];

    try {
      // Find all unique token IDs from holdings using service
      const uniqueTokenIds = await this.holdingService.getDistinctTokenIds();

      if (uniqueTokenIds.length === 0) {
        logger.info('No tokens with holdings found');
        return {
          tokensFound: 0,
          tokensUpdated: 0,
          tokensFailed: 0,
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

      // Fetch token details using batch query
      const tokens = await this.tokenRepository.findByIds(uniqueTokenIds);

      if (tokens.length === 0) {
        logger.warn('No valid tokens found');
        return {
          tokensFound: uniqueTokenIds.length,
          tokensUpdated: 0,
          tokensFailed: uniqueTokenIds.length,
          errors: [
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

      // Recalculate vaults for all tokens that had price updates (best-effort)
      try {
        const updatedTokenIds = tokens
          .filter((t) => {
            const price = prices.get(t.id);
            return price && price !== '0';
          })
          .map((t) => t.id);

        if (updatedTokenIds.length > 0) {
          // Batch query: find all holdings for all updated tokens at once
          const allHoldingsForTokens = await db
            .select({ id: schema.holdings.id, tokenId: schema.holdings.tokenId })
            .from(schema.holdings)
            .where(inArray(schema.holdings.tokenId, updatedTokenIds));

          // Group by tokenId
          const holdingsByToken = new Map<string, string[]>();
          for (const h of allHoldingsForTokens) {
            const ids = holdingsByToken.get(h.tokenId);
            if (ids) {
              ids.push(h.id);
            } else {
              holdingsByToken.set(h.tokenId, [h.id]);
            }
          }

          for (const tokenId of updatedTokenIds) {
            const holdingIds = holdingsByToken.get(tokenId);
            if (holdingIds && holdingIds.length > 0) {
              await this.vaultService.recalculateVaultsForToken(tokenId, holdingIds);
            }
          }
        }
      } catch (vaultError) {
        logger.warn({ error: vaultError }, 'Failed to recalculate vaults after token price update');
      }

      const durationMs = Date.now() - startTime;

      if (tokensFailed > 0) {
        logger.warn(
          {
            tokensFound: uniqueTokenIds.length,
            tokensUpdated,
            tokensFailed,
            failedSymbols: errors.map((e) => e.tokenSymbol).slice(0, 20),
            durationMs,
          },
          'Token price update completed with failures'
        );
      } else {
        logger.info(
          {
            tokensFound: uniqueTokenIds.length,
            tokensUpdated,
            durationMs,
          },
          'Token price update completed'
        );
      }

      return {
        tokensFound: uniqueTokenIds.length,
        tokensUpdated,
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
