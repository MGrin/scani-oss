import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { PricingService } from '../services/pricing/PricingService';

const logger = createComponentLogger('use-case:create-holding');

// Consider a token as having a recent price if there's a price within the last 12 hours
const RECENT_PRICE_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface CreateHoldingInput {
  accountId: string;
  tokenId: string;
  balance: string;
  lastUpdated?: Date;
}

export interface CreateHoldingResult {
  holding: typeof schema.holdings.$inferSelect;
  priceFetchSuccessful: boolean;
  priceFetchError: string | null;
}

/**
 * Use case for creating a new holding with validation and pricing
 *
 * This use case encapsulates the complex logic of:
 * - Validating account ownership and token existence
 * - Creating the holding
 * - Fetching current token price (non-blocking)
 */
@Service()
export class CreateHoldingUseCase {
  private readonly pricingService = Container.get(PricingService);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);

  async execute(
    input: CreateHoldingInput,
    user: typeof schema.users.$inferSelect
  ): Promise<CreateHoldingResult> {
    const now = new Date();
    const userId = user.id;
    logger.debug(
      {
        userId,
        input,
      },
      'Creating holding'
    );

    // Use transaction for all database operations
    // This ensures all validation and creation steps use the same connection
    const holding = await withTransaction(
      async (tx) => {
        // Validate account existence and ownership
        const [account] = await tx
          .select()
          .from(schema.accounts)
          .where(and(eq(schema.accounts.id, input.accountId), eq(schema.accounts.userId, userId)))
          .limit(1);

        if (!account) {
          throw new Error('Account does not exist or does not belong to the current user');
        }

        // Validate token existence
        const [token] = await tx
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, input.tokenId))
          .limit(1);

        if (!token) {
          throw new Error('Token does not exist for the specified tokenId');
        }

        // Create the holding
        const holdingData = {
          ...input,
          userId,
          balance: input.balance || '0',
          createdAt: now,
          lastUpdated: input.lastUpdated || now,
        };

        logger.debug(
          {
            userId,
            accountId: holdingData.accountId,
            tokenId: holdingData.tokenId,
            balance: holdingData.balance,
          },
          'Inserting holding data'
        );

        const [newHolding] = await tx.insert(schema.holdings).values(holdingData).returning();

        if (!newHolding) {
          logger.error(
            {
              userId,
              accountId: holdingData.accountId,
              tokenId: holdingData.tokenId,
            },
            'Failed to create holding - database insert returned no data'
          );
          throw new Error('Failed to create holding - no data returned from database');
        }

        logger.info(
          {
            holdingId: newHolding.id,
            accountId: newHolding.accountId,
            tokenId: newHolding.tokenId,
            balance: newHolding.balance,
          },
          'Holding created successfully in database'
        );

        return newHolding;
      },
      {
        name: 'create-holding',
        timeout: 10000,
      }
    );

    const baseCurrencyId = user?.baseCurrencyId;

    // CRITICAL IMPROVEMENT: Separate external API calls from database transaction
    // Fetch price AFTER holding is created and transaction is committed
    // This prevents external API delays from holding the database connection
    let priceFetchSuccessful = false;
    let priceFetchError: string | null = null;

    try {
      if (baseCurrencyId) {
        // Quick database lookup (outside transaction, connection released)
        const [baseCurrency] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, baseCurrencyId))
          .limit(1);

        // Get token info
        const [token] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, input.tokenId))
          .limit(1);

        if (!token) {
          throw new Error('Token not found');
        }

        if (baseCurrency && token.symbol !== baseCurrency.symbol) {
          // Check if the token has a recent price (within last 12 hours)
          // If not, we need to explicitly fetch it to avoid the holding showing 0 value
          const recentPrice = await this.tokenPriceRepository.findPriceAtTimestamp(
            token.id,
            baseCurrency.id,
            now,
            RECENT_PRICE_WINDOW_MS
          );

          const hasRecentPrice = recentPrice && parseFloat(recentPrice.price) > 0;

          if (hasRecentPrice) {
            // Token already has a recent price, no need to fetch
            priceFetchSuccessful = true;
            logger.debug(
              {
                holdingId: holding.id,
                tokenId: token.id,
                symbol: token.symbol,
                existingPrice: recentPrice.price,
                priceTimestamp: recentPrice.timestamp,
                source: recentPrice.source,
              },
              'Token already has recent price (within 12 hours), skipping fetch'
            );
          } else {
            // Token has no recent price - need to fetch it now
            logger.debug(
              {
                tokenId: token.id,
                symbol: token.symbol,
                baseCurrency: baseCurrency.symbol,
                hasAnyPrice: !!recentPrice,
              },
              'Token has no recent price (within 12 hours), fetching current price for newly created holding'
            );

            // External API call - happens AFTER database connection is released
            const price = await this.pricingService.getTokenPrice(token, baseCurrency.symbol, now);

            if (price && parseFloat(price) > 0) {
              priceFetchSuccessful = true;
              logger.info(
                {
                  holdingId: holding.id,
                  tokenId: token.id,
                  symbol: token.symbol,
                  price,
                  baseCurrency: baseCurrency.symbol,
                },
                'Successfully fetched price for newly created holding'
              );
            } else {
              priceFetchError = 'Price returned as zero or invalid';
              logger.warn(
                {
                  holdingId: holding.id,
                  tokenId: token.id,
                  symbol: token.symbol,
                  price,
                },
                'Token price returned as zero or invalid'
              );
            }
          }
        } else if (token.symbol === baseCurrency?.symbol) {
          // Base currency doesn't need pricing
          priceFetchSuccessful = true;
          logger.debug(
            { tokenId: token.id, symbol: token.symbol },
            'Token is base currency, no pricing needed'
          );
        }
      } else {
        priceFetchError = 'User has no base currency configured';
        logger.warn(
          { userId, tokenId: input.tokenId },
          'Cannot fetch price - user has no base currency'
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      priceFetchError = errorMessage;

      logger.warn(
        {
          holdingId: holding.id,
          tokenId: input.tokenId,
          baseCurrencyId,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to fetch token price after holding creation - holding still created successfully'
      );
      // Holding was already created successfully, pricing failure is non-blocking
    }

    // Create portfolio event for the new holding (best-effort, non-blocking)
    try {
      if (baseCurrencyId) {
        // Get token info and latest price for the event
        const [token] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, input.tokenId))
          .limit(1);

        const [account] = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, input.accountId))
          .limit(1);

        if (token && account) {
          logger.debug(
            { holdingId: holding.id, tokenSymbol: token.symbol },
            'Created holding_create portfolio event'
          );
        }
      }
    } catch (eventError) {
      logger.warn(
        { holdingId: holding.id, error: eventError },
        'Failed to create portfolio event for holding creation'
      );
      // Event creation failure is non-blocking
    }

    return {
      holding,
      priceFetchSuccessful,
      priceFetchError,
    };
  }
}
