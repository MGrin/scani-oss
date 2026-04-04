import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq, lt } from 'drizzle-orm';
import * as schema from '../database/schema';
import { getTestDb, setupTestDb, teardownTestDb } from '../test-utils/setup-test-db';

// Matches SCAM_PROBABILITY_THRESHOLD from config/tokens.ts
const SCAM_PROBABILITY_THRESHOLD = 0.45;

/**
 * Helper: create a test user.
 */
async function createTestUser(
  db: ReturnType<typeof getTestDb>,
  overrides: Partial<schema.NewUser> = {}
) {
  const [user] = await db
    .insert(schema.users)
    .values({
      name: overrides.name ?? 'Test User',
      email: overrides.email ?? `holdinguser-${crypto.randomUUID().slice(0, 8)}@test.com`,
      ...overrides,
    })
    .returning();
  return user;
}

/**
 * Helper: create an account for a user with a seeded institution and account type.
 */
async function createTestAccount(
  db: ReturnType<typeof getTestDb>,
  userId: string,
  name: string,
  institutionName = 'Binance',
  accountTypeCode = 'crypto'
) {
  const [institution] = await db
    .select()
    .from(schema.institutions)
    .where(eq(schema.institutions.name, institutionName))
    .limit(1);
  const [accountType] = await db
    .select()
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, accountTypeCode))
    .limit(1);

  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId,
      institutionId: institution.id,
      name,
      typeId: accountType.id,
    })
    .returning();
  return account;
}

/**
 * Helper: get or create a crypto token.
 */
async function getOrCreateToken(
  db: ReturnType<typeof getTestDb>,
  symbol: string,
  name: string,
  typeCode = 'crypto'
) {
  const [tokenType] = await db
    .select()
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, typeCode))
    .limit(1);

  // Try to find existing
  const [existing] = await db
    .select()
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, symbol), eq(schema.tokens.typeId, tokenType.id)))
    .limit(1);

  if (existing) return existing;

  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol, name, typeId: tokenType.id, decimals: 8 })
    .returning();
  return token;
}

describe('HoldingRepository (integration)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ---------------------------------------------------------------------------
  // Create holding
  // ---------------------------------------------------------------------------

  it('should create a holding', async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const account = await createTestAccount(db, user.id, 'Holding Test Account');
    const token = await getOrCreateToken(db, 'HBTC', 'Bitcoin (holding test)');

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '1.5',
        source: 'manual',
      })
      .returning();

    expect(holding).toBeDefined();
    expect(holding.userId).toBe(user.id);
    expect(holding.accountId).toBe(account.id);
    expect(holding.tokenId).toBe(token.id);
    expect(holding.balance).toBe('1.5');
    expect(holding.source).toBe('manual');
    expect(holding.isHidden).toBe(false);
    expect(holding.isActive).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Find by ID
  // ---------------------------------------------------------------------------

  it('should find a holding by ID', async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const account = await createTestAccount(db, user.id, 'FindById Account');
    const token = await getOrCreateToken(db, 'HETH', 'Ethereum (holding test)');

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '10',
      })
      .returning();

    const [found] = await db
      .select()
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, holding.id), eq(schema.holdings.isHidden, false)))
      .limit(1);

    expect(found).toBeDefined();
    expect(found.id).toBe(holding.id);
    expect(found.balance).toBe('10');
  });

  // ---------------------------------------------------------------------------
  // Find by account
  // ---------------------------------------------------------------------------

  it('should find holdings by account (filtering scam tokens)', async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const account = await createTestAccount(db, user.id, 'ByAccount Account');
    const token1 = await getOrCreateToken(db, 'HADA', 'Cardano (holding test)');
    const token2 = await getOrCreateToken(db, 'HDOT', 'Polkadot (holding test)');

    await db.insert(schema.holdings).values([
      { userId: user.id, accountId: account.id, tokenId: token1.id, balance: '500' },
      { userId: user.id, accountId: account.id, tokenId: token2.id, balance: '200' },
    ]);

    // Replicate HoldingRepository.findByAccount query
    const results = await db
      .select({ holding: schema.holdings })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(
        and(
          eq(schema.holdings.accountId, account.id),
          lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
          eq(schema.holdings.isHidden, false)
        )
      );

    expect(results.length).toBe(2);
    const balances = results.map((r) => r.holding.balance).sort();
    expect(balances).toEqual(['200', '500']);
  });

  // ---------------------------------------------------------------------------
  // Find by user
  // ---------------------------------------------------------------------------

  it('should find holdings by user', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'holdingsuser@test.com' });
    const account1 = await createTestAccount(db, user.id, 'User Acct 1');
    const account2 = await createTestAccount(db, user.id, 'User Acct 2', 'Kraken');
    const token = await getOrCreateToken(db, 'HXRP', 'XRP (holding test)');

    await db.insert(schema.holdings).values([
      { userId: user.id, accountId: account1.id, tokenId: token.id, balance: '100' },
      { userId: user.id, accountId: account2.id, tokenId: token.id, balance: '250' },
    ]);

    // Replicate HoldingRepository.findByUser query
    const results = await db
      .select({ holding: schema.holdings })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(
        and(
          eq(schema.holdings.userId, user.id),
          lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
          eq(schema.holdings.isHidden, false)
        )
      )
      .orderBy(schema.holdings.lastUpdated);

    expect(results.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Find with full details (multi-join)
  // ---------------------------------------------------------------------------

  it('should find holdings with full details (token, account, institution)', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'fulldetails@test.com' });
    const account = await createTestAccount(db, user.id, 'Full Detail Account', 'Binance');
    const token = await getOrCreateToken(db, 'HLINK', 'Chainlink (holding test)');

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '300',
        source: 'manual',
      })
      .returning();

    // Replicate HoldingRepository.findByUserWithFullDetails query
    const results = await db
      .select({
        holdingId: schema.holdings.id,
        holdingUserId: schema.holdings.userId,
        holdingAccountId: schema.holdings.accountId,
        holdingTokenId: schema.holdings.tokenId,
        holdingBalance: schema.holdings.balance,
        holdingSource: schema.holdings.source,
        holdingIsHidden: schema.holdings.isHidden,
        holdingIsActive: schema.holdings.isActive,
        holdingLastUpdated: schema.holdings.lastUpdated,
        holdingCreatedAt: schema.holdings.createdAt,
        token: schema.tokens,
        tokenTypeCode: schema.tokenTypes.code,
        tokenTypeName: schema.tokenTypes.name,
        accountId: schema.accounts.id,
        accountName: schema.accounts.name,
        accountInstitutionId: schema.accounts.institutionId,
        accountTypeCode: schema.accountTypes.code,
        accountTypeName: schema.accountTypes.name,
        institutionId: schema.institutions.id,
        institutionName: schema.institutions.name,
        institutionWebsite: schema.institutions.website,
        institutionTypeCode: schema.institutionTypes.code,
        institutionTypeName: schema.institutionTypes.name,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
      .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
      .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
      .innerJoin(
        schema.institutionTypes,
        eq(schema.institutions.typeId, schema.institutionTypes.id)
      )
      .where(
        and(
          eq(schema.holdings.userId, user.id),
          eq(schema.holdings.isHidden, false),
          lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD)
        )
      );

    expect(results.length).toBe(1);
    const row = results[0];

    // Holding data
    expect(row.holdingId).toBe(holding.id);
    expect(row.holdingBalance).toBe('300');
    expect(row.holdingSource).toBe('manual');

    // Token data
    expect(row.token.symbol).toBe('HLINK');
    expect(row.tokenTypeCode).toBe('crypto');

    // Account data
    expect(row.accountName).toBe('Full Detail Account');
    expect(row.accountTypeCode).toBe('crypto');

    // Institution data
    expect(row.institutionName).toBe('Binance');
    expect(row.institutionTypeCode).toBe('crypto_exchange');
  });

  // ---------------------------------------------------------------------------
  // Hidden holdings
  // ---------------------------------------------------------------------------

  it('should exclude hidden holdings by default', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'hidden@test.com' });
    const account = await createTestAccount(db, user.id, 'Hidden Test Account');
    const token = await getOrCreateToken(db, 'HUNI', 'Uniswap (holding test)');

    // Create a visible and a hidden holding
    await db.insert(schema.holdings).values([
      { userId: user.id, accountId: account.id, tokenId: token.id, balance: '10', isHidden: false },
      { userId: user.id, accountId: account.id, tokenId: token.id, balance: '20', isHidden: true },
    ]);

    // Without includeHidden
    const visible = await db
      .select({ holding: schema.holdings })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(
        and(
          eq(schema.holdings.userId, user.id),
          eq(schema.holdings.isHidden, false),
          lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD)
        )
      );
    expect(visible.length).toBe(1);
    expect(visible[0].holding.balance).toBe('10');

    // With includeHidden
    const all = await db
      .select({ holding: schema.holdings })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(
        and(
          eq(schema.holdings.userId, user.id),
          lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD)
        )
      );
    expect(all.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Scam token filtering
  // ---------------------------------------------------------------------------

  it('should filter out scam tokens', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'scamfilter@test.com' });
    const account = await createTestAccount(db, user.id, 'Scam Filter Account');

    const [cryptoType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'))
      .limit(1);

    // Create a legit token and a scam token
    const [legitToken] = await db
      .insert(schema.tokens)
      .values({
        symbol: 'HLEGIT',
        name: 'Legit Token',
        typeId: cryptoType.id,
        isScamProbability: 0,
      })
      .returning();

    const [scamToken] = await db
      .insert(schema.tokens)
      .values({
        symbol: 'HSCAM',
        name: 'Scam Token',
        typeId: cryptoType.id,
        isScamProbability: 0.9,
      })
      .returning();

    await db.insert(schema.holdings).values([
      { userId: user.id, accountId: account.id, tokenId: legitToken.id, balance: '100' },
      { userId: user.id, accountId: account.id, tokenId: scamToken.id, balance: '999999' },
    ]);

    // Query with scam filter (same as repo)
    const results = await db
      .select({ holding: schema.holdings })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(
        and(
          eq(schema.holdings.userId, user.id),
          lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
          eq(schema.holdings.isHidden, false)
        )
      );

    expect(results.length).toBe(1);
    expect(results[0].holding.tokenId).toBe(legitToken.id);
  });

  // ---------------------------------------------------------------------------
  // Update balance
  // ---------------------------------------------------------------------------

  it('should update holding balance', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'updatebalance@test.com' });
    const account = await createTestAccount(db, user.id, 'Balance Update Account');
    const token = await getOrCreateToken(db, 'HMATIC', 'Polygon (holding test)');

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '100',
      })
      .returning();

    await db
      .update(schema.holdings)
      .set({ balance: '200', lastUpdated: new Date() })
      .where(eq(schema.holdings.id, holding.id));

    const [updated] = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holding.id))
      .limit(1);

    expect(updated.balance).toBe('200');
  });

  // ---------------------------------------------------------------------------
  // Delete holding
  // ---------------------------------------------------------------------------

  it('should delete a holding', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'deleteholding@test.com' });
    const account = await createTestAccount(db, user.id, 'Delete Holding Account');
    const token = await getOrCreateToken(db, 'HAVAX', 'Avalanche (holding test)');

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '50',
      })
      .returning();

    await db.delete(schema.holdings).where(eq(schema.holdings.id, holding.id));

    const remaining = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holding.id));
    expect(remaining.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Cascade delete: account deletion cascades to holdings
  // ---------------------------------------------------------------------------

  it('should cascade delete holdings when account is deleted', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'cascadeholding@test.com' });
    const account = await createTestAccount(db, user.id, 'Cascade Account');
    const token = await getOrCreateToken(db, 'HNEAR', 'Near (holding test)');

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '75',
      })
      .returning();

    // Delete account
    await db.delete(schema.accounts).where(eq(schema.accounts.id, account.id));

    // Holdings should be gone
    const remaining = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holding.id));
    expect(remaining.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Mark as hidden / unhide
  // ---------------------------------------------------------------------------

  it('should mark a holding as hidden and unhide it', async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { email: 'hideunhide@test.com' });
    const account = await createTestAccount(db, user.id, 'HideUnhide Account');
    const token = await getOrCreateToken(db, 'HATOM', 'Cosmos (holding test)');

    const [holding] = await db
      .insert(schema.holdings)
      .values({
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '42',
      })
      .returning();

    expect(holding.isHidden).toBe(false);

    // Mark as hidden
    await db
      .update(schema.holdings)
      .set({ isHidden: true })
      .where(eq(schema.holdings.id, holding.id));

    const [hidden] = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holding.id))
      .limit(1);
    expect(hidden.isHidden).toBe(true);

    // Unhide
    await db
      .update(schema.holdings)
      .set({ isHidden: false })
      .where(eq(schema.holdings.id, holding.id));

    const [unhidden] = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holding.id))
      .limit(1);
    expect(unhidden.isHidden).toBe(false);
  });
});
