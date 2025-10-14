import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { createComponentLogger } from '../../utils/logger';
import type { PricingService } from '../services/PricingService';

const logger = createComponentLogger('use-case:create-holding');

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
 * Use case for creating a new holding with validation, transaction handling, and pricing
 *
 * This use case encapsulates the complex logic of:
 * - Validating account ownership and token existence
 * - Creating the holding within a database transaction
 * - Creating an opening balance transaction if balance > 0
 * - Fetching current token price (non-blocking, after transaction commits)
 *
 * The pricing logic is intentionally outside the transaction to ensure
 * the holding is created even if pricing fails.
 */
@Service()
export class CreateHoldingUseCase {
  constructor(private readonly pricingService: PricingService) {}

  async execute(
    input: CreateHoldingInput,
    userId: string,
    baseCurrencyId?: string
  ): Promise<CreateHoldingResult> {
    const now = new Date();

    logger.debug(
      {
        userId,
        input,
      },
      'Creating holding'
    );

    // Validate account existence and ownership
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, input.accountId), eq(schema.accounts.userId, userId)))
      .limit(1);

    if (!account) {
      throw new Error('Account does not exist or does not belong to the current user');
    }

    // Validate token existence
    const [token] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.id, input.tokenId))
      .limit(1);

    if (!token) {
      throw new Error('Token does not exist for the specified tokenId');
    }

    // CRITICAL: Create holding in transaction, pricing happens AFTER
    const holding = await db.transaction(async (trx) => {
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

      const [holding] = await trx.insert(schema.holdings).values(holdingData).returning();

      if (!holding) {
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
          holdingId: holding.id,
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          balance: holding.balance,
        },
        'Holding created successfully in database'
      );

      // Create opening balance transaction if balance > 0
      if (parseFloat(holding.balance) > 0) {
        // Get the deposit transaction type
        const [depositType] = await trx
          .select()
          .from(schema.transactionTypes)
          .where(
            and(
              eq(schema.transactionTypes.code, 'deposit'),
              eq(schema.transactionTypes.isActive, true)
            )
          )
          .limit(1);

        if (!depositType) {
          logger.error('Deposit transaction type not found in database');
          throw new Error('Deposit transaction type not found');
        }

        await trx.insert(schema.transactions).values({
          userId,
          holdingId: holding.id,
          typeId: depositType.id,
          amount: holding.balance,
          fee: '0',
          description: 'Opening balance - initial holding position',
          timestamp: now,
          createdAt: now,
          updatedAt: now,
        });

        logger.debug(
          { holdingId: holding.id, amount: holding.balance },
          'Created opening balance transaction'
        );
      }

      return holding;
    });

    // CRITICAL FIX: Fetch price AFTER transaction commits
    let priceFetchSuccessful = false;
    let priceFetchError: string | null = null;

    try {
      if (baseCurrencyId) {
        const [baseCurrency] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, baseCurrencyId))
          .limit(1);

        if (baseCurrency && token.symbol !== baseCurrency.symbol) {
          logger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
              baseCurrency: baseCurrency.symbol,
            },
            'Fetching current price for newly created holding'
          );

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
          { userId, tokenId: token.id },
          'Cannot fetch price - user has no base currency'
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      priceFetchError = errorMessage;

      logger.warn(
        {
          holdingId: holding.id,
          tokenId: token.id,
          symbol: token.symbol,
          baseCurrencyId,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to fetch token price after holding creation - holding still created successfully'
      );
      // Holding was already created successfully, pricing failure is non-blocking
    }

    return {
      holding,
      priceFetchSuccessful,
      priceFetchError,
    };
  }
}
