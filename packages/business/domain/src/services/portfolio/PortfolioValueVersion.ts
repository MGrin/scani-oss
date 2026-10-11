import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { makePgArray } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import { readingPairsFor } from '../../engine/price-at';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { PriceHubResolver } from '../pricing/PriceHubResolver';

/**
 * A fingerprint of everything the live valuation reads for one user: the
 * holdings, and the latest reading of every pair `PriceReader` could route a
 * held token through to the user's base — both directions, the hubs and the
 * currencies the token is quoted in. One index probe per pair. And every
 * transfer answered `internal` with its group's legs: an answer can put money
 * in transit without moving any balance (SC-1675).
 */
@Service()
export class PortfolioValueVersion {
  private readonly hubs = Container.get(PriceHubResolver);
  private readonly evidence = Container.get(EngineEvidenceRepository);

  async read(userId: string): Promise<string> {
    const pairs = await this.pairsFor(userId);
    const [row] = (await db.execute<{ v: string }>(sql`
      WITH h AS (
        SELECT id, token_id, account_id, balance, is_active, is_hidden
        FROM holdings WHERE user_id = ${userId}
      ), pairs AS (
        SELECT * FROM unnest(
          ${makePgArray(pairs.map((p) => p.tokenId))}::uuid[],
          ${makePgArray(pairs.map((p) => p.baseTokenId))}::uuid[]
        ) AS pair (token_id, base_token_id)
      )
      SELECT md5(
        coalesce((
          SELECT string_agg(
            concat_ws(',', id, token_id, account_id, balance, is_active, is_hidden),
            ';' ORDER BY id)
          FROM h), '')
        || '|' ||
        coalesce((
          SELECT string_agg(
            concat_ws(',', pairs.token_id, pairs.base_token_id, p.timestamp, p.price),
            ';' ORDER BY pairs.token_id, pairs.base_token_id)
          FROM pairs
          CROSS JOIN LATERAL (
            SELECT tp.timestamp, tp.price FROM token_prices tp
            WHERE tp.token_id = pairs.token_id AND tp.base_token_id = pairs.base_token_id
            ORDER BY tp.timestamp DESC LIMIT 1
          ) p), '')
        || '|' ||
        coalesce((
          SELECT string_agg(
            concat_ws(',', o.id, o.transfer_review, o.transfer_group_id,
              o.transfer_reviewed_at, o.transfer_review_split::text, i.id, i.source,
              i.occurred_at, i.quantity, i.holding_id),
            ';' ORDER BY o.id, i.id)
          FROM holding_transactions o
          LEFT JOIN holding_transactions i
            ON i.transfer_group_id = o.transfer_group_id AND i.user_id = o.user_id AND i.id <> o.id
          WHERE o.user_id = ${userId} AND o.transfer_group_id IS NOT NULL
            AND o.transfer_review IN ('internal', 'split')), '')
      ) AS v
    `)) as unknown as Array<{ v: string }>;
    return row?.v ?? '';
  }

  private async pairsFor(userId: string): Promise<Array<{ tokenId: string; baseTokenId: string }>> {
    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const held = await db
      .selectDistinct({ tokenId: schema.holdings.tokenId })
      .from(schema.holdings)
      .where(and(eq(schema.holdings.userId, userId), eq(schema.holdings.isHidden, false)));
    const tokenIds = held.map((h) => h.tokenId);
    if (tokenIds.length === 0) return [];
    const base = user?.baseCurrencyId ?? (await this.hubs.usdTokenId());
    const [hubTokenIds, quoteTokenIds] = await Promise.all([
      this.hubs.hubTokenIds(),
      this.evidence.findQuoteTokenIds(tokenIds, new Date()),
    ]);
    return readingPairsFor(tokenIds, base, hubTokenIds, quoteTokenIds);
  }
}
