import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';
import { PricingService } from './PricingService';

const DEFAULT_BUDGET_MS = 15_000;

export interface WarmTokenPricesInput {
  userId: string;
  tokenIds: string[];
  budgetMs?: number;
}

@Service()
export class PriceWarmupService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly pricingService = Container.get(PricingService);

  constructor() {
    super('PriceWarmupService');
  }

  // Warm prices for the given tokens with a hard time budget so a
  // stuck / rate-limited provider can't make a user wait forever — the
  // hourly pricing cron picks anything missed.
  async warm(input: WarmTokenPricesInput): Promise<Map<string, string>> {
    const empty = new Map<string, string>();
    if (input.tokenIds.length === 0) return empty;

    const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
    const work = this.runWarmUp(input);
    const timeout = new Promise<Map<string, string>>((resolve) => {
      setTimeout(() => {
        this.logger.warn(
          { userId: input.userId, budgetMs },
          'Token price warm-up exceeded time budget — returning early, cron will backfill'
        );
        resolve(empty);
      }, budgetMs);
    });

    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      this.logger.warn(
        {
          userId: input.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Token price warm-up failed (non-fatal — cron will backfill)'
      );
      return empty;
    }
  }

  private async runWarmUp(input: WarmTokenPricesInput): Promise<Map<string, string>> {
    const uniqueTokenIds = Array.from(new Set(input.tokenIds));
    const tokens = await this.tokenRepository.findByIds(uniqueTokenIds);
    if (tokens.length === 0) return new Map<string, string>();

    const baseCurrencySymbol = await this.resolveBaseCurrencySymbol(input.userId);

    this.logger.info(
      { userId: input.userId, tokenCount: tokens.length, baseCurrencySymbol },
      'Warming prices for tokens'
    );

    const prices = await this.pricingService.getTokenPrices(tokens, baseCurrencySymbol, new Date());

    const pricedCount = Array.from(prices.values()).filter((p) => p && p !== '0').length;
    this.logger.info(
      {
        userId: input.userId,
        tokenCount: tokens.length,
        pricedCount,
        unpricedCount: tokens.length - pricedCount,
      },
      'Token price warm-up completed'
    );

    // The `rescanScamScores` block that stood here is GONE (SC-207), and with
    // it the option that requested it.
    //
    // It re-scored every priced token with `hasPriceData: true` and persisted
    // the lower number. Wallet import asked for it on both of its paths and
    // the wallet-balance sync on a third, so this ran on effectively every
    // wallet the product touches — a scam score that fell whenever our
    // pricing coverage rose, across the whole token table.
    //
    // The score no longer takes a coverage argument, so re-running it here
    // could only recompute the number the token already has. This is not a
    // behaviour that moved; it is one that had no honest version.

    return prices;
  }

  private async resolveBaseCurrencySymbol(userId: string): Promise<string> {
    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user?.baseCurrencyId) return 'USD';

    const [baseToken] = await db
      .select({ symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, user.baseCurrencyId))
      .limit(1);

    return baseToken?.symbol ?? 'USD';
  }
}
