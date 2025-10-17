import { and, eq } from "drizzle-orm";
import Container, { Service } from "typedi";
import { db } from "../../infrastructure/database/connection";
import * as schema from "../../infrastructure/database/schema";
import { createComponentLogger } from "../../utils/logger";
import { PricingService } from "../services/PricingService";

const logger = createComponentLogger("use-case:create-holding");

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
      "Creating holding"
    );

    // Validate account existence and ownership
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, input.accountId),
          eq(schema.accounts.userId, userId)
        )
      )
      .limit(1);

    if (!account) {
      throw new Error(
        "Account does not exist or does not belong to the current user"
      );
    }

    // Validate token existence
    const [token] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.id, input.tokenId))
      .limit(1);

    if (!token) {
      throw new Error("Token does not exist for the specified tokenId");
    }

    const baseCurrencyId = user?.baseCurrencyId;

    // Create the holding
    const holdingData = {
      ...input,
      userId,
      balance: input.balance || "0",
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
      "Inserting holding data"
    );

    const [holding] = await db
      .insert(schema.holdings)
      .values(holdingData)
      .returning();

    if (!holding) {
      logger.error(
        {
          userId,
          accountId: holdingData.accountId,
          tokenId: holdingData.tokenId,
        },
        "Failed to create holding - database insert returned no data"
      );
      throw new Error(
        "Failed to create holding - no data returned from database"
      );
    }

    logger.info(
      {
        holdingId: holding.id,
        accountId: holding.accountId,
        tokenId: holding.tokenId,
        balance: holding.balance,
      },
      "Holding created successfully in database"
    );

    // CRITICAL FIX: Fetch price after holding is created
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
            "Fetching current price for newly created holding"
          );

          const price = await this.pricingService.getTokenPrice(
            token,
            baseCurrency.symbol,
            now
          );

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
              "Successfully fetched price for newly created holding"
            );
          } else {
            priceFetchError = "Price returned as zero or invalid";
            logger.warn(
              {
                holdingId: holding.id,
                tokenId: token.id,
                symbol: token.symbol,
                price,
              },
              "Token price returned as zero or invalid"
            );
          }
        } else if (token.symbol === baseCurrency?.symbol) {
          // Base currency doesn't need pricing
          priceFetchSuccessful = true;
          logger.debug(
            { tokenId: token.id, symbol: token.symbol },
            "Token is base currency, no pricing needed"
          );
        }
      } else {
        priceFetchError = "User has no base currency configured";
        logger.warn(
          { userId, tokenId: token.id },
          "Cannot fetch price - user has no base currency"
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      priceFetchError = errorMessage;

      logger.warn(
        {
          holdingId: holding.id,
          tokenId: token.id,
          symbol: token.symbol,
          baseCurrencyId,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : error,
        },
        "Failed to fetch token price after holding creation - holding still created successfully"
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
