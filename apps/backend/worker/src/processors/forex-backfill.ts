import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { HistoricalPriceBackfillService } from '@scani/domain/services';
import { FOREX_BACKFILL_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { eq, inArray, isNotNull, or } from 'drizzle-orm';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:forex-backfill');

// Hub edges we keep current no matter who is on the platform, all priced
// against USD. The floor, not the list — see `hubEdgeTokens()`.
const BASELINE_HUB_EDGE_SYMBOLS: readonly string[] = [
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

/** Each edge costs `LOOKBACK_DAYS` provider lookups per nightly run. 40 is
 *  roughly ten times the currencies in use today and still a bounded run. */
const MAX_HUB_EDGES = 40;

@Service()
export class ForexBackfillProcessor extends ScheduledJobProcessor {
  readonly descriptor = FOREX_BACKFILL_SCHEDULE;

  /**
   * The currencies this backfill has to keep current: the baseline set, plus
   * every currency a user actually banks in or is billed in (SC-222).
   *
   * A hard-coded list was the reason IDR had **three price rows in its entire
   * history** while a user held payments in it. Nothing was broken — IDR was
   * simply not on the list, so no nightly row was ever written for it, so
   * every read of that pair fell through to a live upstream call behind a
   * two-per-minute limiter. A list maintained by hand is a list that is wrong
   * the moment someone adds a currency nobody anticipated, and the cost of
   * being wrong lands on the user as a 7-second wait, not on us as an alert.
   *
   * `users.base_currency_id` and `payments.currency_token_id` are where a
   * currency enters this system. Holdings are deliberately not included:
   * those are priced by the pricing job through its own providers, and adding
   * 188 crypto tokens to a forex backfill would spend the same scarce limiter
   * budget on pairs exchangerate-api cannot answer anyway.
   */
  private async hubEdgeTokens(usdTokenId: string): Promise<{ symbol: string; id: string }[]> {
    const inUse = await db
      .selectDistinct({ id: schema.tokens.id, symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(
        or(
          inArray(
            schema.tokens.id,
            db
              .select({ id: schema.users.baseCurrencyId })
              .from(schema.users)
              .where(isNotNull(schema.users.baseCurrencyId))
          ),
          inArray(
            schema.tokens.id,
            db.selectDistinct({ id: schema.payments.currencyTokenId }).from(schema.payments)
          ),
          inArray(schema.tokens.symbol, [...BASELINE_HUB_EDGE_SYMBOLS])
        )
      );

    // USD is the hub everything is priced against; an edge from USD to itself
    // is not a rate.
    const edges = inUse.filter((token) => token.id !== usdTokenId);
    if (edges.length <= MAX_HUB_EDGES) return edges;

    // A cap the run announces rather than one it hides. The set is bounded by
    // how many distinct currencies exist on the platform, so this should not
    // fire — and if it does, that is the signal that the union has picked up
    // something it should not have (a payment denominated in a crypto token
    // is the likely candidate) rather than an invitation to raise the number.
    const kept = edges.slice(0, MAX_HUB_EDGES);
    logger.warn(
      {
        found: edges.length,
        cap: MAX_HUB_EDGES,
        dropped: edges.slice(MAX_HUB_EDGES).map((token) => token.symbol),
      },
      'More currencies in use than this backfill will cover in one run'
    );
    return kept;
  }

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
      const hubTokens = await this.hubEdgeTokens(usdTokenId);
      if (hubTokens.length === 0) {
        logger.warn(
          { baselineHubEdgeSymbols: BASELINE_HUB_EDGE_SYMBOLS },
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
      const pairs: { tokenId: string; symbol: string; at: Date }[] = [];
      for (let dayOffset = 0; dayOffset < LOOKBACK_DAYS; dayOffset++) {
        const at = new Date(today);
        at.setUTCDate(at.getUTCDate() - dayOffset);
        for (const { id: tokenId, symbol } of hubTokens) {
          pairs.push({ tokenId, symbol, at });
        }
      }
      // (day, hub-currency) pairs are independent — run them in bounded
      // batches instead of strictly one external call after another.
      const CONCURRENCY = 6;
      for (let i = 0; i < pairs.length; i += CONCURRENCY) {
        const results = await Promise.all(
          pairs.slice(i, i + CONCURRENCY).map(async ({ tokenId, symbol, at }) => ({
            symbol,
            at,
            result: await service.backfillOne(tokenId, at, usdTokenId),
          }))
        );
        for (const { symbol, at, result } of results) {
          attempted++;
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
