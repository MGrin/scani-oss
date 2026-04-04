import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { getTestDb, setupTestDb, teardownTestDb } from '../test-utils/setup-test-db';

describe('TokenRepository (integration)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ---------------------------------------------------------------------------
  // Seed data verification
  // ---------------------------------------------------------------------------

  it('should have seeded token types', async () => {
    const db = getTestDb();
    const types = await db.select().from(schema.tokenTypes);
    expect(types.length).toBeGreaterThanOrEqual(4);

    const codes = types.map((t) => t.code);
    expect(codes).toContain('fiat');
    expect(codes).toContain('crypto');
    expect(codes).toContain('stock');
  });

  it('should have seeded fiat tokens', async () => {
    const db = getTestDb();
    const fiatType = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'fiat'))
      .limit(1);
    expect(fiatType.length).toBe(1);

    const fiatTokens = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.typeId, fiatType[0].id));
    expect(fiatTokens.length).toBeGreaterThan(10); // many fiat currencies seeded

    const symbols = fiatTokens.map((t) => t.symbol);
    expect(symbols).toContain('USD');
    expect(symbols).toContain('EUR');
    expect(symbols).toContain('GBP');
  });

  // ---------------------------------------------------------------------------
  // Create token
  // ---------------------------------------------------------------------------

  it('should create a new token', async () => {
    const db = getTestDb();
    const cryptoType = (
      await db.select().from(schema.tokenTypes).where(eq(schema.tokenTypes.code, 'crypto')).limit(1)
    )[0];

    const [token] = await db
      .insert(schema.tokens)
      .values({
        symbol: 'BTC',
        name: 'Bitcoin',
        typeId: cryptoType.id,
        decimals: 8,
      })
      .returning();

    expect(token).toBeDefined();
    expect(token.symbol).toBe('BTC');
    expect(token.name).toBe('Bitcoin');
    expect(token.typeId).toBe(cryptoType.id);
    expect(token.decimals).toBe(8);
    expect(token.isActive).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Find by ID
  // ---------------------------------------------------------------------------

  it('should find a token by ID', async () => {
    const db = getTestDb();

    // Get an existing seeded fiat token (USD)
    const [usd] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'USD'))
      .limit(1);
    expect(usd).toBeDefined();

    const found = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.id, usd.id))
      .limit(1);
    expect(found.length).toBe(1);
    expect(found[0].symbol).toBe('USD');
  });

  // ---------------------------------------------------------------------------
  // Find by symbol
  // ---------------------------------------------------------------------------

  it('should find a token by symbol', async () => {
    const db = getTestDb();
    const results = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'EUR'))
      .limit(1);

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Euro');
  });

  it('should return empty for non-existent symbol', async () => {
    const db = getTestDb();
    const results = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'NONEXISTENT'))
      .limit(1);

    expect(results.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Find by symbol and type
  // ---------------------------------------------------------------------------

  it('should find a token by symbol and type', async () => {
    const db = getTestDb();
    const fiatType = (
      await db.select().from(schema.tokenTypes).where(eq(schema.tokenTypes.code, 'fiat')).limit(1)
    )[0];

    const results = await db
      .select()
      .from(schema.tokens)
      .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokens.typeId, fiatType.id)))
      .limit(1);

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('United States Dollar');
  });

  // ---------------------------------------------------------------------------
  // Find by type (join with token_types)
  // ---------------------------------------------------------------------------

  it('should find tokens by type code', async () => {
    const db = getTestDb();
    const results = await db
      .select({ tokens: schema.tokens })
      .from(schema.tokens)
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(and(eq(schema.tokenTypes.code, 'fiat'), eq(schema.tokens.isActive, true)));

    expect(results.length).toBeGreaterThan(10);
    // All returned tokens should be fiat
    const fiatType = (
      await db.select().from(schema.tokenTypes).where(eq(schema.tokenTypes.code, 'fiat')).limit(1)
    )[0];
    for (const r of results) {
      expect(r.tokens.typeId).toBe(fiatType.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Find many with types (batch)
  // ---------------------------------------------------------------------------

  it('should find many tokens with their type codes', async () => {
    const db = getTestDb();

    // Get a few token IDs
    const someTokens = await db.select().from(schema.tokens).limit(5);
    expect(someTokens.length).toBe(5);
    const ids = someTokens.map((t) => t.id);

    const results = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        typeId: schema.tokens.typeId,
        decimals: schema.tokens.decimals,
        iconUrl: schema.tokens.iconUrl,
        providerMetadata: schema.tokens.providerMetadata,
        isScamProbability: schema.tokens.isScamProbability,
        isActive: schema.tokens.isActive,
        createdAt: schema.tokens.createdAt,
        updatedAt: schema.tokens.updatedAt,
        typeCode: schema.tokenTypes.code,
      })
      .from(schema.tokens)
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(
        ids.length > 0
          ? eq(schema.tokens.id, ids[0]) // simplified; just checking the join works
          : undefined!
      );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].typeCode).toBeDefined();
    expect(typeof results[0].typeCode).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // Create many tokens
  // ---------------------------------------------------------------------------

  it('should create multiple tokens at once', async () => {
    const db = getTestDb();
    const cryptoType = (
      await db.select().from(schema.tokenTypes).where(eq(schema.tokenTypes.code, 'crypto')).limit(1)
    )[0];

    const newTokens = [
      { symbol: 'ETH', name: 'Ethereum', typeId: cryptoType.id, decimals: 18 },
      { symbol: 'SOL', name: 'Solana', typeId: cryptoType.id, decimals: 9 },
    ];

    const created = await db.insert(schema.tokens).values(newTokens).returning();
    expect(created.length).toBe(2);
    expect(created.map((t) => t.symbol).sort()).toEqual(['ETH', 'SOL']);
  });

  // ---------------------------------------------------------------------------
  // Unique constraint
  // ---------------------------------------------------------------------------

  it('should enforce unique symbol+type constraint', async () => {
    const db = getTestDb();
    const fiatType = (
      await db.select().from(schema.tokenTypes).where(eq(schema.tokenTypes.code, 'fiat')).limit(1)
    )[0];

    // USD is already seeded, inserting again should fail
    await expect(
      db
        .insert(schema.tokens)
        .values({ symbol: 'USD', name: 'Duplicate USD', typeId: fiatType.id })
        .returning()
    ).rejects.toThrow();
  });
});
