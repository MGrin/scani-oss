import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { TokenRepository } from '../repositories/TokenRepository';
import { PricingService } from '../services/pricing/PricingService';

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
 * shows values immediately instead of waiting for the hourly pricing cron.
 *
 * **Prices, and nothing else.** This paragraph used to continue "Also
 * re-scores scam probability once prices land", and both that sentence and
 * the `ScamTokenDetectionService` it named outlived the behaviour by one
 * ticket: SC-207 removed the re-scoring and left the description and the
 * injected dependency behind (SC-297). The file then said two opposite
 * things about itself — this header claimed the re-scoring happened, and the
 * note at the end of `runWarmUp` explained why it had been deleted.
 *
 * That combination is worse than either half alone. A reader who found scam
 * detection wired into the price-warming path would reasonably conclude that
 * pricing still moves the scam score, which is the exact defect SC-207
 * existed to remove, in the one file whose history makes it plausible.
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

    // The re-scoring that used to live here is GONE (SC-207).
    //
    // It re-ran detection with `hasPriceData: true` and persisted the lower
    // number, so a token's scam score fell when our pricing coverage improved.
    // Its log line read "lowered false positives", which is one true reading
    // of the same write; the other is that a token quarantined at 1.00 became
    // 0.70 and read as ordinary, with nothing recording that it had ever been
    // otherwise.
    //
    // With the coverage signal removed from the score, re-scoring here could
    // only ever compute the number the token already has — the inputs are its
    // symbol and its name, and neither changed. So this is not a behaviour
    // that moved elsewhere; it is one that had no honest version.
    //
    // **A scam score is now a creation-time verdict and nothing revises it
    // downward.** If a later signal should raise or clear one, it needs its
    // own additive field and its own provenance, the way `lookalike_of` does
    // (SC-197) — not a silent overwrite of the column every filter reads.

    return prices;
  }
}
