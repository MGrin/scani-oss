import { nanoid } from 'nanoid';
import { db } from './connection';
import * as schema from './schema';

// Type assertion for test operations (development/test environment uses SQLite)
const testDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

/**
 * Clear all test data from the database in dependency order
 */
export async function clearTestData() {
  // Clear data in reverse dependency order
  await testDb.delete(schema.transactions);
  await testDb.delete(schema.tokenPrices);
  await testDb.delete(schema.holdings);
  await testDb.delete(schema.accounts);
  await testDb.delete(schema.institutions);
  await testDb.delete(schema.institutionTypes);
  await testDb.delete(schema.tokens);
  await testDb.delete(schema.users);
}

/**
 * Create minimal test data for tests that need it
 */
export async function createTestData() {
  // Create a test user
  const [user] = await testDb
    .insert(schema.users)
    .values({
      id: 'test-user-1',
      email: 'test@example.com',
      name: 'Test User',
      baseCurrency: 'USD',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    })
    .returning();

  if (!user) throw new Error('Failed to create test user');

  // Create essential tokens for testing
  const tokensData = [
    {
      id: nanoid(),
      symbol: 'USD',
      name: 'US Dollar',
      type: 'fiat' as const,
      decimals: 2,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      symbol: 'BTC',
      name: 'Bitcoin',
      type: 'crypto' as const,
      decimals: 8,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      symbol: 'AAPL',
      name: 'Apple Inc.',
      type: 'stock' as const,
      decimals: 2,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      symbol: 'ETH',
      name: 'Ethereum',
      type: 'crypto' as const,
      decimals: 18,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      symbol: 'MSFT',
      name: 'Microsoft Corporation',
      type: 'stock' as const,
      decimals: 2,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      symbol: 'TSLA',
      name: 'Tesla Inc.',
      type: 'stock' as const,
      decimals: 2,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
  ];

  const insertedTokens = await testDb.insert(schema.tokens).values(tokensData).returning();
  const usdToken = insertedTokens.find((t) => t.symbol === 'USD');
  const aaplToken = insertedTokens.find((t) => t.symbol === 'AAPL');

  if (!usdToken || !aaplToken) throw new Error('Failed to create required tokens');

  // Create institution types
  const institutionTypesData = [
    {
      id: nanoid(),
      code: 'bank' as const,
      name: 'Bank',
      description: 'Traditional banks and credit unions',
      displayOrder: 1,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      code: 'broker' as const,
      name: 'Broker',
      description: 'Investment brokerages and trading platforms',
      displayOrder: 2,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
  ];

  const insertedInstitutionTypes = await testDb
    .insert(schema.institutionTypes)
    .values(institutionTypesData)
    .returning();

  const bankType = insertedInstitutionTypes.find((t) => t.code === 'bank');
  const brokerType = insertedInstitutionTypes.find((t) => t.code === 'broker');

  if (!bankType || !brokerType) throw new Error('Failed to create institution types');

  // Create test institutions
  const institutionsData = [
    {
      id: nanoid(),
      userId: user.id,
      name: 'Test Bank',
      typeId: bankType.id,
      description: 'Test Bank for testing',
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      userId: user.id,
      name: 'Test Broker',
      typeId: brokerType.id,
      description: 'Test Broker for testing',
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
  ];

  const insertedInstitutions = await testDb
    .insert(schema.institutions)
    .values(institutionsData)
    .returning();

  const testBank = insertedInstitutions.find((i) => i.name === 'Test Bank');
  const testBroker = insertedInstitutions.find((i) => i.name === 'Test Broker');

  if (!testBank || !testBroker) throw new Error('Failed to create institutions');

  // Create test accounts
  const accountsData = [
    {
      id: nanoid(),
      institutionId: testBank.id,
      name: 'Test Checking',
      type: 'checking' as const,
      description: 'Test checking account',
      accountNumber: '****1234',
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      institutionId: testBroker.id,
      name: 'Test Investment',
      type: 'investment' as const,
      description: 'Test investment account',
      accountNumber: '****5678',
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
  ];

  const insertedAccounts = await testDb.insert(schema.accounts).values(accountsData).returning();
  const testChecking = insertedAccounts.find((a) => a.name === 'Test Checking');
  const testInvestment = insertedAccounts.find((a) => a.name === 'Test Investment');

  if (!testChecking || !testInvestment) throw new Error('Failed to create accounts');

  // Create test holdings
  const holdingsData = [
    {
      id: nanoid(),
      accountId: testChecking.id,
      tokenId: usdToken.id,
      balance: 5000.0,
      lastUpdated: new Date('2024-01-15'),
      createdAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      accountId: testInvestment.id,
      tokenId: usdToken.id,
      balance: 1000.0,
      lastUpdated: new Date('2024-01-15'),
      createdAt: new Date('2024-01-01'),
    },
    {
      id: nanoid(),
      accountId: testInvestment.id,
      tokenId: aaplToken.id,
      balance: 10.0,
      averageCostBasis: 150.0,
      lastUpdated: new Date('2024-01-15'),
      createdAt: new Date('2024-01-10'),
    },
  ];

  const insertedHoldings = await testDb.insert(schema.holdings).values(holdingsData).returning();

  if (insertedHoldings.length < 3) {
    throw new Error(`Expected 3 holdings but got ${insertedHoldings.length}`);
  }

  const [holding1, holding2, holding3] = insertedHoldings;

  if (!holding1 || !holding2 || !holding3) {
    throw new Error('Failed to create all required holdings');
  }

  // Create test transactions
  const transactionsData = [
    {
      id: nanoid(),
      holdingId: holding1.id,
      type: 'deposit' as const,
      amount: 2000.0,
      fee: 0,
      description: 'Test deposit',
      timestamp: new Date('2024-01-15'),
      createdAt: new Date('2024-01-15'),
      updatedAt: new Date('2024-01-15'),
    },
    {
      id: nanoid(),
      holdingId: holding2.id,
      type: 'transfer' as const,
      amount: 1500.0,
      fee: 0,
      description: 'Test transfer',
      timestamp: new Date('2024-01-10'),
      createdAt: new Date('2024-01-10'),
      updatedAt: new Date('2024-01-10'),
    },
    {
      id: nanoid(),
      holdingId: holding3.id,
      type: 'buy' as const,
      amount: -1500.0,
      price: 150.0,
      fee: 0.5,
      description: 'Test buy',
      timestamp: new Date('2024-01-10'),
      createdAt: new Date('2024-01-10'),
      updatedAt: new Date('2024-01-10'),
    },
  ];

  await testDb.insert(schema.transactions).values(transactionsData);

  return {
    user,
    tokens: insertedTokens,
    institutionTypes: insertedInstitutionTypes,
    institutions: insertedInstitutions,
    accounts: insertedAccounts,
    holdings: insertedHoldings,
    transactions: transactionsData.length,
  };
}

/**
 * Set up test environment with a separate test database path
 */
export function setupTestEnvironment() {
  // Ensure we're using a separate test database
  const originalDbPath = process.env.DB_PATH;
  const testDbPath = ':memory:'; // Use in-memory database for tests
  process.env.DB_PATH = testDbPath;

  return {
    cleanup: () => {
      // Restore original DB path
      if (originalDbPath) {
        process.env.DB_PATH = originalDbPath;
      } else {
        delete process.env.DB_PATH;
      }
    },
  };
}
