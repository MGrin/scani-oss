/**
 * Clear bad cached prices (price = 0 from CoinGecko empty responses)
 * This allows pricing to be re-attempted with the correct provider (DeFiLlama)
 */
import { and, eq, like } from 'drizzle-orm';
import { db } from '../infrastructure/database/connection';
import * as schema from '../infrastructure/database/schema';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('clear-bad-prices');

async function clearBadPrices() {
  logger.info({}, '🧹 Clearing bad cached prices...');

  try {
    // Delete prices with value '0' from CoinGecko (empty responses)
    const deleted = await db
      .delete(schema.tokenPrices)
      .where(and(eq(schema.tokenPrices.price, '0'), like(schema.tokenPrices.source, '%CoinGecko%')))
      .returning({
        id: schema.tokenPrices.id,
        tokenId: schema.tokenPrices.tokenId,
        source: schema.tokenPrices.source,
      });

    logger.info(
      { count: deleted.length },
      `✅ Cleared ${deleted.length} bad cached prices from CoinGecko empty responses`
    );

    for (const price of deleted) {
      logger.debug(
        { priceId: price.id, tokenId: price.tokenId, source: price.source },
        'Deleted bad price'
      );
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '❌ Failed to clear bad prices'
    );
    throw error;
  }
}

clearBadPrices()
  .then(() => {
    logger.info({}, '✅ Bad price cache cleared successfully');
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ error }, '❌ Failed to clear bad prices');
    process.exit(1);
  });
