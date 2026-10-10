import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { lastRefusal } from '@scani/providers/core/refusals';
import { emitEntityChange } from '@scani/realtime';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { notScamFor } from '../lib/scam-verdict';
import { TokenRepository } from '../repositories/TokenRepository';
import { CacheWriteCounter } from '../services/feeds/CacheWriteCounter';
import { PricingService } from '../services/pricing/PricingService';
import { ACTIVE_PRICE_WINDOW_MS } from '../services/pricing/price-windows';

const logger = createComponentLogger('use-case:price-active-users-crypto');

/** A tab stamps `app_seen_at` every 15 minutes; 20 allows one late stamp. */
const SEEN_WITHIN_MS = 20 * 60_000;

/**
 * After CoinGecko refuses us for rate, this run stands aside for an hour, so
 * the hourly run, which every user depends on, keeps the per-minute budget.
 */
const BACK_OFF_AFTER_REFUSAL_MS = 60 * 60_000;

export interface PriceActiveUsersCryptoResult {
  backedOff: boolean;
  activeUsers: number;
  tokensHeld: number;
  tokensAsked: number;
  /** Cached holding values this run wrote, apart from the hourly run's (SC-1610). */
  cacheWrites: number;
}

/**
 * Keeps the crypto that open apps show priced within 15 minutes (SC-1602).
 * One run serves every user seen in the last 20 minutes, so the provider is
 * asked once per run for the union of what they hold, however many there are.
 * A token priced inside `ACTIVE_PRICE_WINDOW_MS` is not asked again, and a
 * zero balance shows no value, so it is not asked at all.
 */
@Service()
export class PriceActiveUsersCryptoUseCase {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly pricingService = Container.get(PricingService);
  private readonly cacheWriteCounter = Container.get(CacheWriteCounter);

  async execute(now: Date = new Date()): Promise<PriceActiveUsersCryptoResult> {
    const refusedAt = lastRefusal('coingecko');
    if (refusedAt !== undefined && now.getTime() - refusedAt < BACK_OFF_AFTER_REFUSAL_MS) {
      logger.info({ refusedAt: new Date(refusedAt) }, 'CoinGecko refused us recently; backing off');
      return { backedOff: true, activeUsers: 0, tokensHeld: 0, tokensAsked: 0, cacheWrites: 0 };
    }
    const active = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(gte(schema.users.appSeenAt, new Date(now.getTime() - SEEN_WITHIN_MS)));
    if (active.length === 0) {
      return { backedOff: false, activeUsers: 0, tokensHeld: 0, tokensAsked: 0, cacheWrites: 0 };
    }
    const userIds = active.map((u) => u.id);

    const held = await db
      .selectDistinct({ tokenId: schema.holdings.tokenId })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(
        and(
          inArray(schema.holdings.userId, userIds),
          eq(schema.holdings.isHidden, false),
          sql`${schema.holdings.balance}::numeric <> 0`,
          notScamFor()
        )
      );
    const tokens = (
      await this.tokenRepository.findManyWithTypes(held.map((h) => h.tokenId))
    ).filter((token) => token.typeCode === 'crypto');

    const { asked: tokensAsked, cacheWrites } = await this.pricingService.fetchUnlessCurrent(
      tokens,
      now,
      ACTIVE_PRICE_WINDOW_MS
    );
    await this.cacheWriteCounter.add('active', cacheWrites, now);
    if (tokensAsked > 0) {
      for (const userId of userIds) {
        emitEntityChange({
          entityType: 'holding',
          operationType: 'sync',
          userId,
          data: { reason: 'price_refresh', tokensAsked },
        });
      }
    }
    const result = {
      backedOff: false,
      activeUsers: userIds.length,
      tokensHeld: tokens.length,
      tokensAsked,
      cacheWrites,
    };
    logger.info(result, 'Priced the crypto open apps show');
    return result;
  }
}
