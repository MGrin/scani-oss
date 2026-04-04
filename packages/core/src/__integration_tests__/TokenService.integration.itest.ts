import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../database/schema';
import { setupTestDb, teardownTestDb } from '../test-utils/setup-test-db';

let db: PostgresJsDatabase<typeof schema>;

describe('TokenService (integration)', () => {
  beforeAll(async () => {
    db = await setupTestDb();
  }, 90_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ---------------------------------------------------------------
  // Helper: look up a seeded token type by code
  // ---------------------------------------------------------------
  async function getTokenTypeByCode(code: string) {
    const [row] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, code))
      .limit(1);
    return row;
  }

  // ---------------------------------------------------------------
  // findOrCreateToken — creates new, then finds existing
  // ---------------------------------------------------------------
  describe('findOrCreateToken (via direct DB operations)', () => {
    it('should create a new crypto token when it does not exist', async () => {
      const cryptoType = await getTokenTypeByCode('crypto');
      expect(cryptoType).toBeDefined();

      // Insert
      const [created] = await db
        .insert(schema.tokens)
        .values({
          symbol: 'BTC',
          name: 'Bitcoin',
          typeId: cryptoType.id,
          decimals: 8,
          providerMetadata: JSON.stringify({ provider: 'coingecko', coingecko: { id: 'bitcoin' } }),
          isActive: true,
        })
        .returning();

      expect(created).toBeDefined();
      expect(created.id).toBeTruthy();
      expect(created.symbol).toBe('BTC');
      expect(created.name).toBe('Bitcoin');
      expect(created.typeId).toBe(cryptoType.id);
      expect(created.decimals).toBe(8);
    });

    it('should find existing token by symbol and type (no duplicate creation)', async () => {
      const cryptoType = await getTokenTypeByCode('crypto');
      expect(cryptoType).toBeDefined();

      // BTC was created in the previous test — look it up
      const [existing] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'BTC'))
        .limit(1);

      expect(existing).toBeDefined();
      expect(existing.symbol).toBe('BTC');
      expect(existing.typeId).toBe(cryptoType.id);
    });

    it('should create a stock token', async () => {
      const stockType = await getTokenTypeByCode('stock');
      expect(stockType).toBeDefined();

      const [created] = await db
        .insert(schema.tokens)
        .values({
          symbol: 'AAPL',
          name: 'Apple Inc.',
          typeId: stockType.id,
          decimals: 2,
          providerMetadata: JSON.stringify({ provider: 'finnhub', finnhub: { symbol: 'AAPL' } }),
          isActive: true,
        })
        .returning();

      expect(created).toBeDefined();
      expect(created.symbol).toBe('AAPL');
      expect(created.typeId).toBe(stockType.id);
    });

    it('should allow the same symbol under different token types', async () => {
      // "USD" already exists as fiat from seeded data — create a crypto "USD" (e.g. stablecoin ticker)
      const cryptoType = await getTokenTypeByCode('crypto');
      const fiatType = await getTokenTypeByCode('fiat');

      // Fiat USD should already be seeded
      const [fiatUsd] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'USD'))
        .limit(1);
      expect(fiatUsd).toBeDefined();
      expect(fiatUsd.typeId).toBe(fiatType.id);

      // Insert crypto-typed "USD" (e.g. bridged dollar)
      const [cryptoUsd] = await db
        .insert(schema.tokens)
        .values({
          symbol: 'USD',
          name: 'USD Stablecoin',
          typeId: cryptoType.id,
          decimals: 6,
          providerMetadata: '{}',
          isActive: true,
        })
        .returning();

      expect(cryptoUsd).toBeDefined();
      expect(cryptoUsd.typeId).toBe(cryptoType.id);
      // Two distinct tokens with the same symbol but different types
      expect(fiatUsd.id).not.toBe(cryptoUsd.id);
    });

    it('should reject duplicate symbol + type combination', async () => {
      const cryptoType = await getTokenTypeByCode('crypto');

      // BTC crypto was created above — inserting again should violate unique constraint
      let error: Error | undefined;
      try {
        await db.insert(schema.tokens).values({
          symbol: 'BTC',
          name: 'Bitcoin (duplicate)',
          typeId: cryptoType.id,
          decimals: 8,
          providerMetadata: '{}',
          isActive: true,
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      // Postgres unique violation — Drizzle wraps the error; the underlying cause
      // has code '23505'. The top-level message contains "Failed query" from DrizzleQueryError.
      const errAny = error as Record<string, unknown>;
      const pgCode = String((errAny.cause as Record<string, unknown>)?.code || errAny.code || '');
      const isUniqueViolation =
        pgCode === '23505' ||
        error!.message.includes('unique') ||
        error!.message.includes('duplicate');
      expect(isUniqueViolation).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // getTokensByIds — batch fetch
  // ---------------------------------------------------------------
  describe('getTokensByIds (batch fetch)', () => {
    it('should return all tokens matching the given ids', async () => {
      // Grab a few seeded fiat tokens
      const fiats = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'EUR'))
        .limit(1);
      const eurToken = fiats[0];
      expect(eurToken).toBeDefined();

      const gbps = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'GBP'))
        .limit(1);
      const gbpToken = gbps[0];
      expect(gbpToken).toBeDefined();

      // Batch fetch by IDs
      const ids = [eurToken.id, gbpToken.id];
      const results = await db.select().from(schema.tokens).where(
        // drizzle inArray
        require('drizzle-orm').inArray(schema.tokens.id, ids)
      );

      expect(results.length).toBe(2);
      const symbols = results.map((r: typeof schema.tokens.$inferSelect) => r.symbol).sort();
      expect(symbols).toEqual(['EUR', 'GBP']);
    });

    it('should return empty array for non-existent ids', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const results = await db
        .select()
        .from(schema.tokens)
        .where(require('drizzle-orm').inArray(schema.tokens.id, [fakeId]));

      expect(results.length).toBe(0);
    });

    it('should handle mix of existing and non-existent ids', async () => {
      const [usd] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'USD'))
        .limit(1);
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const results = await db
        .select()
        .from(schema.tokens)
        .where(require('drizzle-orm').inArray(schema.tokens.id, [usd.id, fakeId]));

      // Only the real token should come back (may be 1 or 2 since there could be crypto USD too)
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r: typeof schema.tokens.$inferSelect) => r.symbol === 'USD')).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Seeded token types verification
  // ---------------------------------------------------------------
  describe('seeded token types', () => {
    it('should have crypto, stock, and fiat token types', async () => {
      const crypto = await getTokenTypeByCode('crypto');
      const stock = await getTokenTypeByCode('stock');
      const fiat = await getTokenTypeByCode('fiat');

      expect(crypto).toBeDefined();
      expect(crypto.code).toBe('crypto');
      expect(crypto.name).toBe('Cryptocurrency');

      expect(stock).toBeDefined();
      expect(stock.code).toBe('stock');

      expect(fiat).toBeDefined();
      expect(fiat.code).toBe('fiat');
    });

    it('should have private-company and other token types', async () => {
      const privateCompany = await getTokenTypeByCode('private-company');
      const other = await getTokenTypeByCode('other');

      expect(privateCompany).toBeDefined();
      expect(privateCompany.code).toBe('private-company');

      expect(other).toBeDefined();
      expect(other.code).toBe('other');
    });
  });
});
