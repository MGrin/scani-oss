import { cached } from '../../cache';
import { type Result, tryCatch } from '../../result';
import { getSql } from './sql';

export interface HoldingStats {
  holdings: number;
  tokens: number;
  tokenPrices: number;
  tokenPricesFreshestAt: string | null;
  dbSizeBytes: number;
  dbSizePretty: string;
  /** Holdings grouped by `source` (blockchain / cex / brokerage / manual / …). */
  bySource: Array<{ source: string; count: number }>;
  /** Holdings with `lastUpdated > 24h ago` and `isActive = true`. */
  staleActive: number;
  /** Total user_wallets — moved here from integrationStats since "wallets" are really holdings-side. */
  userWallets: number;
}

interface CountsRow {
  holdings: string;
  tokens: string;
  token_prices: string;
  user_wallets: string;
  stale_active: string;
}

interface SizeRow {
  bytes: string;
  pretty: string;
}

export async function getHoldingStats(): Promise<Result<HoldingStats>> {
  return tryCatch(() =>
    cached('app-db:holding-stats', 60, async () => {
      const db = await getSql();
      const [countsRow, freshestRow, sizeRow, bySourceRows] = (await Promise.all([
        db`
          SELECT
            (SELECT count(*) FROM holdings)::text AS holdings,
            (SELECT count(*) FROM tokens)::text AS tokens,
            (SELECT count(*) FROM token_prices)::text AS token_prices,
            (SELECT count(*) FROM user_wallets)::text AS user_wallets,
            (SELECT count(*) FROM holdings
              WHERE is_active = true
                AND (last_updated IS NULL OR last_updated < now() - interval '24 hours')
            )::text AS stale_active
        `,
        db`SELECT max(timestamp) AS freshest FROM token_prices`,
        db`
          SELECT pg_database_size(current_database())::text AS bytes,
                 pg_size_pretty(pg_database_size(current_database())) AS pretty
        `,
        db`
          SELECT source, count(*)::text AS count
          FROM holdings
          GROUP BY source
          ORDER BY count(*) DESC
        `,
      ])) as [
        CountsRow[],
        Array<{ freshest: string | null }>,
        SizeRow[],
        Array<{ source: string; count: string }>,
      ];

      const counts = countsRow[0];
      const freshest = freshestRow[0];
      const size = sizeRow[0];
      if (!counts || !freshest || !size) throw new Error('holding stats query returned empty');

      return {
        holdings: Number.parseInt(counts.holdings, 10),
        tokens: Number.parseInt(counts.tokens, 10),
        tokenPrices: Number.parseInt(counts.token_prices, 10),
        tokenPricesFreshestAt: freshest.freshest ? new Date(freshest.freshest).toISOString() : null,
        dbSizeBytes: Number.parseInt(size.bytes, 10),
        dbSizePretty: size.pretty,
        bySource: bySourceRows.map((r) => ({
          source: r.source ?? 'unknown',
          count: Number.parseInt(r.count, 10),
        })),
        staleActive: Number.parseInt(counts.stale_active, 10),
        userWallets: Number.parseInt(counts.user_wallets, 10),
      };
    })
  );
}
