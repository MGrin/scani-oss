import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { TokenRepository } from '../repositories/TokenRepository';
import { PricingService } from '../services/PricingService';
import { ScamTokenDetectionService } from '../services/ScamTokenDetectionService';

const logger = createComponentLogger('use-case:warm-token-prices-for-import');

/**
 * Hard cap on how long we're willing to delay the import response to
 * warm prices. Chosen so a ~50-token wallet with healthy providers
 * comfortably finishes, but a stuck / rate-limited provider can't make
 * the user wait forever.
 */
const WARM_UP_BUDGET_MS = 15_000;

interface WarmInput {
  userId: string;
  tokenIds: string[];
}

/**
 * After a wallet import commits, warm token prices so the review screen
 * shows values immediately instead of waiting for the hourly pricing
 * cron. Also re-scores scam probability once prices land — scoring at
 * creation time inflates the score because `hasPriceData=false`; now
 * that we have prices, legitimate tokens (ETH, USDC) drop out of the
 * scam filter.
 *
 * Extracted from `ImportWalletAddressUseCase` (was a 130-LOC private
 * method). Splitting it out means the main import use case is smaller
 * and this pass is independently testable / re-usable by other import
 * paths (exchange, IBKR) that want the same warm-on-commit UX.
 */
@Service()
export class WarmTokenPricesForImportUseCase {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly pricingService = Container.get(PricingService);
  private readonly scamDetectionService = Container.get(ScamTokenDetectionService);

  async execute(input: WarmInput): Promise<Map<string, string>> {
    const emptyPrices = new Map<string, string>();
    if (input.tokenIds.length === 0) return emptyPrices;

    const work = this.runWarmUp(input);

    const timeout = new Promise<Map<string, string>>((resolve) => {
      setTimeout(() => {
        logger.warn(
          { userId: input.userId, budgetMs: WARM_UP_BUDGET_MS },
          'Token price warm-up exceeded time budget — returning early, cron will backfill'
        );
        resolve(emptyPrices);
      }, WARM_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      logger.warn(
        {
          userId: input.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Token price warm-up failed (non-fatal — cron will backfill)'
      );
      return emptyPrices;
    }
  }

  private async runWarmUp(input: WarmInput): Promise<Map<string, string>> {
    const uniqueTokenIds = Array.from(new Set(input.tokenIds));
    const tokens = await this.tokenRepository.findByIds(uniqueTokenIds);
    if (tokens.length === 0) return new Map<string, string>();

    // Resolve base currency once so prices are stored against the right
    // reference token. Fall back to USD — PricingService handles the
    // symbol lookup internally.
    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);

    let baseCurrencySymbol = 'USD';
    if (user?.baseCurrencyId) {
      const [baseToken] = await db
        .select({ symbol: schema.tokens.symbol })
        .from(schema.tokens)
        .where(eq(schema.tokens.id, user.baseCurrencyId))
        .limit(1);
      if (baseToken?.symbol) {
        baseCurrencySymbol = baseToken.symbol;
      }
    }

    logger.info(
      { userId: input.userId, tokenCount: tokens.length, baseCurrencySymbol },
      'Warming prices for imported tokens'
    );

    const prices = await this.pricingService.getTokenPrices(tokens, baseCurrencySymbol, new Date());

    const pricedCount = Array.from(prices.values()).filter((p) => p && p !== '0').length;
    logger.info(
      {
        userId: input.userId,
        tokenCount: tokens.length,
        pricedCount,
        unpricedCount: tokens.length - pricedCount,
      },
      'Token price warm-up completed'
    );

    // Re-evaluate scam scores for tokens that received a valid price.
    // At creation time, hasPriceData=false inflates the score. Now that
    // we have pricing data, re-run detection to lower false positives
    // for legitimate tokens like ETH, USDC, etc.
    const tokensToReScore = tokens.filter((t) => {
      const price = prices.get(t.id);
      return price && price !== '0';
    });

    if (tokensToReScore.length > 0) {
      let reScored = 0;
      for (const token of tokensToReScore) {
        const newScore = this.scamDetectionService.calculateScamProbability(
          token.symbol,
          token.name,
          token.createdAt,
          true // hasPriceData — the key difference vs. creation-time score
        );
        if (newScore !== token.isScamProbability) {
          await this.tokenRepository.update(token.id, {
            isScamProbability: newScore,
          });
          reScored++;
        }
      }
      if (reScored > 0) {
        logger.info(
          { reScored, total: tokensToReScore.length },
          'Re-evaluated scam scores after pricing — lowered false positives'
        );
      }
    }

    return prices;
  }
}
