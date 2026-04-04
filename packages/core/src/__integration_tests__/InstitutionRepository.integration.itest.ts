import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, ilike } from 'drizzle-orm';
import * as schema from '../database/schema';
import { getTestDb, setupTestDb, teardownTestDb } from '../test-utils/setup-test-db';

describe('InstitutionRepository (integration)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ---------------------------------------------------------------------------
  // Seed data verification
  // ---------------------------------------------------------------------------

  it('should have seeded institution types', async () => {
    const db = getTestDb();
    const types = await db.select().from(schema.institutionTypes);
    expect(types.length).toBeGreaterThanOrEqual(8);

    const codes = types.map((t) => t.code);
    expect(codes).toContain('bank');
    expect(codes).toContain('broker');
    expect(codes).toContain('crypto_exchange');
    expect(codes).toContain('crypto_wallet');
  });

  it('should have seeded institutions', async () => {
    const db = getTestDb();
    const institutions = await db.select().from(schema.institutions);
    // The seed inserts ~241 institutions
    expect(institutions.length).toBeGreaterThan(100);
  });

  // ---------------------------------------------------------------------------
  // Find all
  // ---------------------------------------------------------------------------

  it('should find all institutions', async () => {
    const db = getTestDb();
    const all = await db.select().from(schema.institutions);
    expect(all.length).toBeGreaterThan(100);
    // All should have required fields
    for (const inst of all) {
      expect(inst.id).toBeDefined();
      expect(inst.name).toBeDefined();
      expect(inst.typeId).toBeDefined();
    }
  });

  // ---------------------------------------------------------------------------
  // Find by ID
  // ---------------------------------------------------------------------------

  it('should find an institution by ID (Binance)', async () => {
    const db = getTestDb();
    // First find Binance by name
    const [binance] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.name, 'Binance'))
      .limit(1);

    expect(binance).toBeDefined();
    expect(binance.name).toBe('Binance');

    // Now find by ID
    const [found] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.id, binance.id))
      .limit(1);

    expect(found).toBeDefined();
    expect(found.id).toBe(binance.id);
    expect(found.name).toBe('Binance');
  });

  it('should return empty for non-existent institution ID', async () => {
    const db = getTestDb();
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const results = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.id, fakeUuid))
      .limit(1);

    expect(results.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Find by name
  // ---------------------------------------------------------------------------

  it('should find an institution by exact name', async () => {
    const db = getTestDb();
    const results = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.name, 'Kraken'))
      .limit(1);

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Kraken');
  });

  it('should find institutions by name pattern (case-insensitive)', async () => {
    const db = getTestDb();
    const results = await db
      .select()
      .from(schema.institutions)
      .where(ilike(schema.institutions.name, '%bank%'));

    // There should be many banks in the seed data
    expect(results.length).toBeGreaterThan(0);
    for (const inst of results) {
      expect(inst.name.toLowerCase()).toContain('bank');
    }
  });

  // ---------------------------------------------------------------------------
  // Find by institution type
  // ---------------------------------------------------------------------------

  it('should find institutions with their type info via join', async () => {
    const db = getTestDb();
    const results = await db
      .select({
        institution: schema.institutions,
        typeCode: schema.institutionTypes.code,
        typeName: schema.institutionTypes.name,
      })
      .from(schema.institutions)
      .leftJoin(schema.institutionTypes, eq(schema.institutions.typeId, schema.institutionTypes.id))
      .where(eq(schema.institutions.name, 'Binance'))
      .limit(1);

    expect(results.length).toBe(1);
    expect(results[0].typeCode).toBe('crypto_exchange');
    expect(results[0].typeName).toBe('Crypto Exchange');
  });

  it('should find all crypto exchanges', async () => {
    const db = getTestDb();
    const [cryptoExchangeType] = await db
      .select()
      .from(schema.institutionTypes)
      .where(eq(schema.institutionTypes.code, 'crypto_exchange'))
      .limit(1);

    const exchanges = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.typeId, cryptoExchangeType.id));

    expect(exchanges.length).toBeGreaterThan(0);
    // Binance should be among them
    const names = exchanges.map((e) => e.name);
    expect(names).toContain('Binance');
    expect(names).toContain('Kraken');
  });

  // ---------------------------------------------------------------------------
  // Website unique constraint
  // ---------------------------------------------------------------------------

  it('should enforce unique website constraint', async () => {
    const db = getTestDb();
    // Get Binance to find its website and type
    const [binance] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.name, 'Binance'))
      .limit(1);

    // Trying to insert with same website should fail
    if (binance.website) {
      await expect(
        db
          .insert(schema.institutions)
          .values({
            name: 'Duplicate Institution',
            typeId: binance.typeId,
            website: binance.website,
          })
          .returning()
      ).rejects.toThrow();
    }
  });

  // ---------------------------------------------------------------------------
  // Active filter
  // ---------------------------------------------------------------------------

  it('should filter by isActive', async () => {
    const db = getTestDb();
    const active = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.isActive, true));

    // All seeded institutions should be active
    expect(active.length).toBeGreaterThan(100);
  });
});
