import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { HistoricalPriceBackfillService } from '@scani/domain/services';
import { FOREX_BACKFILL_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:forex-backfill');

// Hub edges we keep current, all priced against USD. Add new pairs
// here as the user base expands into more regional bases.
const HUB_EDGE_SYMBOLS: readonly string[] = [
  'EUR',
  'GBP',
  'JPY',
  'RUB',
  'CHF',
  'CAD',
  'AUD',
  'USDT',
];

const LOOKBACK_DAYS = 7;

@Service()
export class ForexBackfillProcessor extends ScheduledJobProcessor {
  readonly descriptor = FOREX_BACKFILL_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting forex backfill');
    try {
      const usdRow = await db
        .select({ id: schema.tokens.id })
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'USD'))
        .limit(1);
      const usdTokenId = usdRow[0]?.id;
      if (!usdTokenId) {
        logger.warn('No USD token in database; skipping forex backfill');
        return;
      }
      const hubTokens: { symbol: string; id: string }[] = [];
      for (const symbol of HUB_EDGE_SYMBOLS) {
        const row = await db
          .select({ id: schema.tokens.id })
          .from(schema.tokens)
          .where(eq(schema.tokens.symbol, symbol))
          .limit(1);
        if (row[0]) hubTokens.push({ symbol, id: row[0].id });
      }
      if (hubTokens.length === 0) {
        logger.warn(
          { hubEdgeSymbols: HUB_EDGE_SYMBOLS },
          'No hub-edge tokens in database; skipping forex backfill'
        );
        return;
      }
      const service = Container.get(HistoricalPriceBackfillService);
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      let attempted = 0;
      let inserted = 0;
      let alreadyHad = 0;
      let providerMissing = 0;
      for (let dayOffset = 0; dayOffset < LOOKBACK_DAYS; dayOffset++) {
        const at = new Date(today);
        at.setUTCDate(at.getUTCDate() - dayOffset);
        for (const { id: tokenId, symbol } of hubTokens) {
          attempted++;
          const result = await service.backfillOne(tokenId, at, usdTokenId);
          if (result.status === 'inserted') inserted++;
          else if (result.status === 'already-have') alreadyHad++;
          else if (result.status === 'provider-missing') {
            providerMissing++;
            logger.debug({ symbol, at }, 'No provider could price this hub edge');
          }
        }
      }
      logger.info(
        {
          hubEdgeCount: hubTokens.length,
          lookbackDays: LOOKBACK_DAYS,
          attempted,
          inserted,
          alreadyHad,
          providerMissing,
          totalMs: Date.now() - startTime,
        },
        '✅ Forex backfill complete'
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - startTime,
        },
        '❌ Forex backfill failed'
      );
      throw error;
    }
  }
}
