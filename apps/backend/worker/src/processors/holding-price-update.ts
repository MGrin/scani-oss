import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { PortfolioValueCache } from '@scani/domain/services';
import { UpdateHoldingPriceUseCase } from '@scani/domain/use-cases';
import { HOLDING_PRICE_UPDATE, type HoldingPriceUpdateJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, RedisResourceLock, UserJobProcessor } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:holding-price-update');

// Lock TTL: long enough that a healthy price fetch + vault-recalc
// finishes inside the window (~5-10s typical), short enough that a
// crashed worker's lock unblocks the next attempt within the BullMQ
// retry backoff (2s → 4s → 8s).
const PRICE_LOCK_TTL_MS = 30_000;

// Per-holdingId lock around the price-fetch + vault-recalc pipeline.
// Race we're preventing: the user clicks "update price" twice in
// quick succession (or the UI retries after a transient error), two
// workers pick up the two jobs, both call the pricing providers
// (wasted RPC + per-provider rate-limit pressure), and both
// recalculate vaults against intermediate prices.
@Service()
export class HoldingPriceUpdateProcessor extends UserJobProcessor<HoldingPriceUpdateJob, unknown> {
  readonly descriptor = HOLDING_PRICE_UPDATE;
  private readonly resourceLock = Container.get(RedisResourceLock);

  protected async handle(data: HoldingPriceUpdateJob, _ctx: ProcessorContext): Promise<unknown> {
    const lockKey = `lock:holding-price:${data.holdingId}`;
    const lock = await this.resourceLock.acquire(lockKey, PRICE_LOCK_TTL_MS);
    if (!lock.ok) {
      logger.info(
        { holdingId: data.holdingId, userId: data.userId },
        'Price update already in progress — skipping duplicate'
      );
      return { skipped: true, reason: 'lock-contention' };
    }
    try {
      const baseCurrency = await this.resolveBaseCurrencySymbol(data.userId);
      const result = await Container.get(UpdateHoldingPriceUseCase).execute(
        data.holdingId,
        data.userId,
        baseCurrency
      );

      // The holding's price (and thus value) changed — drop the user's
      // cached portfolio valuation so the next read recomputes.
      await Container.get(PortfolioValueCache).bust(data.userId);

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: data.holdingId,
        userId: data.userId,
      });
      return result;
    } finally {
      await lock.release();
    }
  }

  private async resolveBaseCurrencySymbol(userId: string): Promise<string> {
    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user?.baseCurrencyId) return 'USD';

    const [token] = await db
      .select({ symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, user.baseCurrencyId))
      .limit(1);

    return token?.symbol || 'USD';
  }
}
