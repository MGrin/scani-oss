import { db } from '@scani/db/connection';
import { sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { PRICE_HUBS } from '../pricing/price-hubs';

@Service()
export class PortfolioValueVersion {
  async read(userId: string): Promise<string> {
    const hubs = sql.join(
      PRICE_HUBS.map((hub) => sql`(${hub.symbol}, ${hub.typeCode})`),
      sql`, `
    );
    const [row] = (await db.execute<{ v: string }>(sql`
      WITH h AS (
        SELECT id, token_id, account_id, balance, is_active, is_hidden
        FROM holdings WHERE user_id = ${userId}
      ), b AS (
        SELECT base_currency_id AS id FROM users
        WHERE id = ${userId} AND base_currency_id IS NOT NULL
        UNION
        SELECT t.id FROM tokens t JOIN token_types tt ON tt.id = t.type_id
        WHERE (t.symbol, tt.code) IN (${hubs})
      ), t AS (
        SELECT DISTINCT token_id AS id FROM h WHERE NOT is_hidden
        UNION SELECT id FROM b
      )
      SELECT md5(
        coalesce((
          SELECT string_agg(
            concat_ws(',', id, token_id, account_id, balance, is_active, is_hidden),
            ';' ORDER BY id)
          FROM h), '')
        || '|' ||
        coalesce((
          SELECT string_agg(concat_ws(',', t.id, b.id, p.timestamp, p.price), ';' ORDER BY t.id, b.id)
          FROM t CROSS JOIN b
          CROSS JOIN LATERAL (
            SELECT tp.timestamp, tp.price FROM token_prices tp
            WHERE tp.token_id = t.id AND tp.base_token_id = b.id
            ORDER BY tp.timestamp DESC LIMIT 1
          ) p), '')
      ) AS v
    `)) as unknown as Array<{ v: string }>;
    return row?.v ?? '';
  }
}
