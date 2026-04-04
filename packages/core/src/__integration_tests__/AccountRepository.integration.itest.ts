import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { getTestDb, setupTestDb, teardownTestDb } from '../test-utils/setup-test-db';

/**
 * Helper: create a test user (directly in the users table).
 * The users table has no FK to auth.users in this schema so this works
 * in the testcontainer environment.
 */
async function createTestUser(
  db: ReturnType<typeof getTestDb>,
  overrides: Partial<schema.NewUser> = {}
) {
  const [user] = await db
    .insert(schema.users)
    .values({
      name: overrides.name ?? 'Test User',
      email: overrides.email ?? `testuser-${crypto.randomUUID().slice(0, 8)}@test.com`,
      ...overrides,
    })
    .returning();
  return user;
}

describe('AccountRepository (integration)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ---------------------------------------------------------------------------
  // Seed data verification
  // ---------------------------------------------------------------------------

  it('should have seeded account types', async () => {
    const db = getTestDb();
    const types = await db.select().from(schema.accountTypes);
    expect(types.length).toBeGreaterThanOrEqual(5);

    const codes = types.map((t) => t.code);
    expect(codes).toContain('checking');
    expect(codes).toContain('savings');
    expect(codes).toContain('investment');
    expect(codes).toContain('crypto');
  });

  // ---------------------------------------------------------------------------
  // Create account
  // ---------------------------------------------------------------------------

  it('should create an account for a user', async () => {
    const db = getTestDb();
    const user = await createTestUser(db);

    // Pick a seeded institution and account type
    const [institution] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.name, 'Binance'))
      .limit(1);
    const [accountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);

    const [account] = await db
      .insert(schema.accounts)
      .values({
        userId: user.id,
        institutionId: institution.id,
        name: 'My Binance Account',
        typeId: accountType.id,
        description: 'Test crypto account',
      })
      .returning();

    expect(account).toBeDefined();
    expect(account.userId).toBe(user.id);
    expect(account.institutionId).toBe(institution.id);
    expect(account.name).toBe('My Binance Account');
    expect(account.typeId).toBe(accountType.id);
    expect(account.isActive).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Find by user
  // ---------------------------------------------------------------------------

  it('should find accounts by user with type info', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'findbyuser@test.com' });

    // Create two accounts for this user at different institutions
    const institutions = await db.select().from(schema.institutions).limit(2);
    const [checkingType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'checking'))
      .limit(1);
    const [investmentType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'investment'))
      .limit(1);

    await db.insert(schema.accounts).values([
      {
        userId: user.id,
        institutionId: institutions[0].id,
        name: 'Checking 1',
        typeId: checkingType.id,
      },
      {
        userId: user.id,
        institutionId: institutions[1].id,
        name: 'Investment 1',
        typeId: investmentType.id,
      },
    ]);

    // Query pattern from AccountRepository.findByUser
    const results = await db
      .select({
        account: schema.accounts,
        type: schema.accountTypes.code,
        typeName: schema.accountTypes.name,
      })
      .from(schema.accounts)
      .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
      .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.isActive, true)))
      .orderBy(schema.accounts.name);

    expect(results.length).toBe(2);
    // Ordered alphabetically by name: Checking 1, Investment 1
    expect(results[0].account.name).toBe('Checking 1');
    expect(results[0].type).toBe('checking');
    expect(results[1].account.name).toBe('Investment 1');
    expect(results[1].type).toBe('investment');
  });

  it('should return empty for user with no accounts', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'noaccount@test.com' });

    const results = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, user.id));

    expect(results.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Find by institution
  // ---------------------------------------------------------------------------

  it('should find accounts by institution', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'byinst@test.com' });
    const [institution] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.name, 'Kraken'))
      .limit(1);
    const [accountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);

    await db.insert(schema.accounts).values({
      userId: user.id,
      institutionId: institution.id,
      name: 'Kraken Account',
      typeId: accountType.id,
    });

    const results = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.institutionId, institution.id));

    expect(results.length).toBeGreaterThanOrEqual(1);
    const krakenAccount = results.find((a) => a.name === 'Kraken Account');
    expect(krakenAccount).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Unique constraint: name per user per institution
  // ---------------------------------------------------------------------------

  it('should enforce unique name per user per institution', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'uniqueconst@test.com' });
    const [institution] = await db.select().from(schema.institutions).limit(1);
    const [accountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'checking'))
      .limit(1);

    await db.insert(schema.accounts).values({
      userId: user.id,
      institutionId: institution.id,
      name: 'Duplicate Name',
      typeId: accountType.id,
    });

    // Same name + user + institution should fail
    await expect(
      db
        .insert(schema.accounts)
        .values({
          userId: user.id,
          institutionId: institution.id,
          name: 'Duplicate Name',
          typeId: accountType.id,
        })
        .returning()
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  it('should store and retrieve JSON metadata', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'metadata@test.com' });
    const [institution] = await db.select().from(schema.institutions).limit(1);
    const [accountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);

    const metadata = { walletAddress: '0xabc123', chain: 'ethereum' };
    const [account] = await db
      .insert(schema.accounts)
      .values({
        userId: user.id,
        institutionId: institution.id,
        name: 'Wallet Account',
        typeId: accountType.id,
        metadata,
      })
      .returning();

    expect(account.metadata).toEqual(metadata);

    // Re-read from DB
    const [fetched] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .limit(1);
    expect(fetched.metadata).toEqual(metadata);
  });

  // ---------------------------------------------------------------------------
  // Update account
  // ---------------------------------------------------------------------------

  it('should update account fields', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'update@test.com' });
    const [institution] = await db.select().from(schema.institutions).limit(1);
    const [accountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'checking'))
      .limit(1);

    const [account] = await db
      .insert(schema.accounts)
      .values({
        userId: user.id,
        institutionId: institution.id,
        name: 'Original Name',
        typeId: accountType.id,
      })
      .returning();

    const [updated] = await db
      .update(schema.accounts)
      .set({ name: 'Updated Name', description: 'New description', updatedAt: new Date() })
      .where(eq(schema.accounts.id, account.id))
      .returning();

    expect(updated.name).toBe('Updated Name');
    expect(updated.description).toBe('New description');
  });

  // ---------------------------------------------------------------------------
  // Cascade delete: user deletion cascades to accounts
  // ---------------------------------------------------------------------------

  it('should cascade delete accounts when user is deleted', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'cascade@test.com' });
    const [institution] = await db.select().from(schema.institutions).limit(1);
    const [accountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'savings'))
      .limit(1);

    const [account] = await db
      .insert(schema.accounts)
      .values({
        userId: user.id,
        institutionId: institution.id,
        name: 'To Be Cascaded',
        typeId: accountType.id,
      })
      .returning();

    // Delete the user
    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    // Account should be gone
    const remaining = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id));
    expect(remaining.length).toBe(0);
  });
});
