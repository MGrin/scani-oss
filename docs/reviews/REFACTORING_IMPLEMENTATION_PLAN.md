# Scani Finance - Refactoring Implementation Plan

**Date:** February 2026  
**Goal:** Transform the codebase to proper Onion Architecture with SOLID principles  
**Constraint:** Database data must be preserved; no backward compatibility required otherwise

---

## Overview

This plan consists of **8 phases** that progressively transform the architecture from its current state (64% of use cases bypassing repositories) to an ideal state (all data access through repositories with proper interfaces).

```
TRANSFORMATION ROADMAP:

Phase 1: Foundation (Interfaces)
    ↓
Phase 2: Repository Completion
    ↓
Phase 3: PricingService Split
    ↓
Phase 4: Service Layer Fix
    ↓
Phase 5: Use Cases Refactor
    ↓
Phase 6: Large Files Split
    ↓
Phase 7: Standardization
    ↓
Phase 8: Cleanup & Validation
```

---

## Phase 1: Foundation - Create All Interfaces

**Objective:** Define contracts for all layers to enable proper dependency inversion.

### 1.1 Create Repository Interfaces

Create directory: `packages/core/src/repositories/interfaces/`

**Files to create:**

```
packages/core/src/repositories/interfaces/
├── index.ts
├── IBaseRepository.ts
├── IHoldingRepository.ts
├── IAccountRepository.ts
├── ITokenRepository.ts
├── ITokenPriceRepository.ts
├── IGroupRepository.ts
├── IUserPortfolioEventRepository.ts
├── IInstitutionRepository.ts
├── IUserRepository.ts
├── IUserWalletRepository.ts
├── IUserIntegrationCredentialsRepository.ts
├── IInstitutionBlockchainMappingRepository.ts
├── IApiKeyRepository.ts
└── IEnumRepositories.ts
```

**Example interface structure:**

```typescript
// IHoldingRepository.ts
export interface IHoldingRepository {
  // Base operations
  findById(id: string, transaction?: DatabaseTransaction): Promise<Holding | null>;
  findByIds(ids: string[], transaction?: DatabaseTransaction): Promise<Holding[]>;
  create(data: NewHolding, transaction?: DatabaseTransaction): Promise<Holding>;
  update(id: string, data: Partial<Holding>, transaction?: DatabaseTransaction): Promise<Holding>;
  delete(id: string, transaction?: DatabaseTransaction): Promise<void>;
  
  // Domain-specific operations
  findByUser(userId: string, options?: FindByUserOptions, transaction?: DatabaseTransaction): Promise<Holding[]>;
  findByUserWithFullDetails(userId: string, options?: FindByUserOptions, transaction?: DatabaseTransaction): Promise<HoldingWithDetails[]>;
  findByAccount(accountId: string, transaction?: DatabaseTransaction): Promise<Holding[]>;
  findActiveByToken(tokenId: string, transaction?: DatabaseTransaction): Promise<Holding[]>;
  markAsHidden(id: string, userId: string, transaction?: DatabaseTransaction): Promise<void>;
  updateBalance(id: string, balance: string, transaction?: DatabaseTransaction): Promise<Holding>;
  
  // Event-aware operations (NEW)
  createWithEvent(data: NewHolding, eventContext: EventContext, transaction?: DatabaseTransaction): Promise<Holding>;
  updateBalanceWithEvent(id: string, balance: string, eventContext: EventContext, transaction?: DatabaseTransaction): Promise<Holding>;
  deleteWithEvent(id: string, userId: string, eventContext: EventContext, transaction?: DatabaseTransaction): Promise<void>;
}
```

### 1.2 Create Service Interfaces

Create directory: `packages/core/src/services/interfaces/`

**Files to create:**

```
packages/core/src/services/interfaces/
├── index.ts
├── IHoldingService.ts
├── IAccountService.ts
├── ITokenService.ts
├── IPricingService.ts
├── IPortfolioValuationService.ts
├── IPortfolioHistoryService.ts
├── IDashboardService.ts
├── IInstitutionService.ts
├── IUserService.ts
├── IUserContextService.ts
├── IUserPortfolioEventService.ts
├── IApiKeyService.ts
├── IUserWalletService.ts
├── IIntegrationCredentialsService.ts
├── ITokenValidationService.ts
├── IScamTokenDetectionService.ts
└── IAIService.ts
```

### 1.3 Create Use Case Interfaces

Create directory: `packages/core/src/use-cases/interfaces/`

**Files to create:**

```
packages/core/src/use-cases/interfaces/
├── index.ts
├── ICreateHoldingUseCase.ts
├── IDeleteHoldingUseCase.ts
├── IUpdateHoldingUseCase.ts
├── IUpdateHoldingsBatchUseCase.ts
├── IImportBinanceAccountsUseCase.ts
├── IImportKrakenAccountsUseCase.ts
├── IImportWalletAddressUseCase.ts
├── ISyncExchangeBalancesUseCase.ts
├── ISyncWalletBalancesUseCase.ts
├── IGetAssetAllocationUseCase.ts
├── IParseScreenshotUseCase.ts
├── IUpdateHoldingPriceUseCase.ts
├── ICreateHoldingsWithDependenciesUseCase.ts
└── IUpdateTokenPricesUseCase.ts
```

### 1.4 Update Implementations to Implement Interfaces

For each repository, service, and use case, add `implements I*`:

```typescript
// Before
@Service()
export class HoldingRepository extends BaseRepository<Holding, NewHolding> { }

// After
@Service()
export class HoldingRepository extends BaseRepository<Holding, NewHolding> implements IHoldingRepository { }
```

### 1.5 Deliverables

- [ ] 14 repository interface files created
- [ ] 17 service interface files created  
- [ ] 14 use case interface files created
- [ ] All implementations updated with `implements` clause
- [ ] TypeScript compilation passes
- [ ] All tests pass

---

## Phase 2: Repository Completion

**Objective:** Add all missing repository methods so higher layers never need direct DB access.

### 2.1 Audit Required Operations

For each file that currently bypasses repositories, identify what operations it performs:

**CreateHoldingUseCase.ts:**
- Query account by ID and user → `AccountRepository.findByIdAndUser()`
- Query token by symbol and type → `TokenRepository.findBySymbolAndType()` ✓ (exists)
- Create holding → `HoldingRepository.create()` ✓ (exists)
- Create portfolio event → `UserPortfolioEventService` ✓ (exists)

**ImportBinanceAccountsUseCase.ts:**
- Query institution by name → `InstitutionRepository.findByName()` (MISSING)
- Query account by user and institution → `AccountRepository.findByUserAndInstitution()` (MISSING)
- Bulk create/update accounts → `AccountRepository.upsertMany()` (MISSING)
- Bulk create/update holdings → `HoldingRepository.upsertMany()` (MISSING)
- Query holding by account and token → `HoldingRepository.findByAccountAndToken()` (MISSING)

**ImportKrakenAccountsUseCase.ts:**
- Same as Binance above

**ImportWalletAddressUseCase.ts:**
- All of the above plus:
- Query wallet by address → `UserWalletRepository.findByAddress()` ✓ (exists)
- Update wallet metadata → `UserWalletRepository.updateMetadata()` (MISSING)

**SyncExchangeBalancesUseCase.ts:**
- Query holdings with token details → `HoldingRepository.findByAccountWithTokenDetails()` (MISSING)
- Batch update holdings → `HoldingRepository.batchUpdateBalances()` (MISSING)

**SyncWalletBalancesUseCase.ts:**
- Same as SyncExchangeBalances

**UpdateHoldingsBatchUseCase.ts:**
- Batch update holdings → `HoldingRepository.batchUpdateBalances()` (MISSING)

### 2.2 Add Missing Repository Methods

**HoldingRepository additions:**

```typescript
// packages/core/src/repositories/HoldingRepository.ts

async findByIdAndUser(id: string, userId: string, transaction?: DatabaseTransaction): Promise<Holding | null>;

async findByAccountAndToken(accountId: string, tokenId: string, transaction?: DatabaseTransaction): Promise<Holding | null>;

async findByAccountWithTokenDetails(accountId: string, transaction?: DatabaseTransaction): Promise<HoldingWithToken[]>;

async upsertMany(
  data: NewHolding[], 
  conflictTarget: ['accountId', 'tokenId'],
  transaction?: DatabaseTransaction
): Promise<Holding[]>;

async batchUpdateBalances(
  updates: Array<{ id: string; balance: string }>,
  transaction?: DatabaseTransaction
): Promise<void>;

// Event-aware methods
async createWithEvent(
  data: NewHolding,
  eventContext: EventContext,
  transaction?: DatabaseTransaction
): Promise<Holding>;

async updateBalanceWithEvent(
  id: string,
  balance: string,
  eventContext: EventContext,
  transaction?: DatabaseTransaction
): Promise<Holding>;

async deleteWithEvent(
  id: string,
  userId: string,
  eventContext: EventContext,
  transaction?: DatabaseTransaction
): Promise<void>;
```

**AccountRepository additions:**

```typescript
// packages/core/src/repositories/AccountRepository.ts

async findByIdAndUser(id: string, userId: string, transaction?: DatabaseTransaction): Promise<Account | null>;

async findByUserAndInstitution(
  userId: string, 
  institutionId: string, 
  transaction?: DatabaseTransaction
): Promise<Account[]>;

async findByUserInstitutionAndExternalId(
  userId: string,
  institutionId: string,
  externalId: string,
  transaction?: DatabaseTransaction
): Promise<Account | null>;

async upsertMany(
  data: NewAccount[],
  conflictTarget: ['userId', 'institutionId', 'externalId'],
  transaction?: DatabaseTransaction
): Promise<Account[]>;
```

**InstitutionRepository additions:**

```typescript
// packages/core/src/repositories/InstitutionRepository.ts

async findByName(name: string, transaction?: DatabaseTransaction): Promise<Institution | null>;

async findByWebsite(website: string, transaction?: DatabaseTransaction): Promise<Institution | null>;

async findOrCreate(data: NewInstitution, transaction?: DatabaseTransaction): Promise<Institution>;
```

**UserWalletRepository additions:**

```typescript
// packages/core/src/repositories/UserWalletRepository.ts

async updateMetadata(
  id: string,
  metadata: Record<string, unknown>,
  transaction?: DatabaseTransaction
): Promise<UserWallet>;

async updateInstitutionIds(
  id: string,
  institutionIds: string[],
  transaction?: DatabaseTransaction
): Promise<UserWallet>;
```

### 2.3 Implement Event-Aware Repository Methods

The key innovation is moving event creation INTO the repository:

```typescript
// HoldingRepository.ts
async createWithEvent(
  data: NewHolding,
  eventContext: EventContext,
  transaction?: DatabaseTransaction
): Promise<Holding> {
  const db = this.getDb(transaction);
  
  // Create holding
  const [holding] = await db
    .insert(this.table)
    .values(data)
    .returning();
  
  // Create event in same transaction
  await db
    .insert(schema.userPortfolioEvents)
    .values({
      id: generateId(),
      userId: data.userId,
      holdingId: holding.id,
      accountId: data.accountId,
      eventType: 'holding_created',
      timestamp: new Date(),
      tokenSymbol: eventContext.tokenSymbol,
      tokenName: eventContext.tokenName,
      newBalance: data.balance,
      previousBalance: '0',
      newValueInBaseCurrency: eventContext.valueInBaseCurrency,
      previousValueInBaseCurrency: '0',
    });
  
  return holding;
}
```

### 2.4 Deliverables

- [ ] All missing repository methods identified and documented
- [ ] HoldingRepository: 8 new methods added
- [ ] AccountRepository: 4 new methods added
- [ ] InstitutionRepository: 3 new methods added
- [ ] UserWalletRepository: 2 new methods added
- [ ] Event-aware methods implemented in HoldingRepository
- [ ] All interfaces updated with new methods
- [ ] TypeScript compilation passes
- [ ] All tests pass

---

## Phase 3: Split PricingService God Class

**Objective:** Break down the 2059-line PricingService into focused, single-responsibility services.

### 3.1 Identify Responsibilities

Current PricingService handles:
1. Rate limiting management
2. Provider registry and selection
3. Price caching
4. Currency conversion
5. Price fetching orchestration
6. Failure handling and fallbacks
7. Token grouping by provider

### 3.2 Create New Service Structure

```
packages/core/src/services/pricing/
├── index.ts                       # Re-exports
├── RateLimiterRegistry.ts         # All rate limiters
├── PriceProviderRegistry.ts       # Provider management
├── PriceCacheService.ts           # Caching logic
├── CurrencyConversionService.ts   # Currency rates
├── PriceFetcherService.ts         # Core fetching logic
├── PricingService.ts              # Orchestration only (~300 lines)
└── interfaces/
    ├── IPriceProvider.ts
    ├── IRateLimiterRegistry.ts
    ├── IPriceCacheService.ts
    └── ICurrencyConversionService.ts
```

### 3.3 RateLimiterRegistry

```typescript
// packages/core/src/services/pricing/RateLimiterRegistry.ts
@Service()
export class RateLimiterRegistry {
  // Move all rate limiters from PricingService
  readonly coinGecko = new RateLimiter(10, 60_000);
  readonly coinGeckoFree = new RateLimiter(5, 60_000);
  readonly finnhub = new RateLimiter(50, 60_000);
  readonly defillama = new RateLimiter(50, 60_000);
  readonly blockchain = {
    solana: new RateLimiter(10, 1_000),
    ethereum: new RateLimiter(10, 1_000),
    // ... others
  };

  getForProvider(provider: string): RateLimiter {
    // Return appropriate rate limiter
  }
}
```

### 3.4 PriceCacheService

```typescript
// packages/core/src/services/pricing/PriceCacheService.ts
@Service()
export class PriceCacheService extends BaseService {
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);

  constructor() {
    super('PriceCacheService');
  }

  async getCachedPrice(
    tokenId: string,
    baseCurrencyId: string,
    maxAgeMs: number = 5 * 60 * 1000
  ): Promise<TokenPrice | null> {
    const price = await this.tokenPriceRepository.findLatestPrice(tokenId, baseCurrencyId);
    if (!price) return null;
    
    const age = Date.now() - price.timestamp.getTime();
    return age < maxAgeMs ? price : null;
  }

  async cachePrice(price: NewTokenPrice): Promise<TokenPrice> {
    return await this.tokenPriceRepository.create(price);
  }

  async bulkCachePrices(prices: NewTokenPrice[]): Promise<void> {
    await this.tokenPriceRepository.bulkUpsert(prices);
  }
}
```

### 3.5 CurrencyConversionService

```typescript
// packages/core/src/services/pricing/CurrencyConversionService.ts
@Service()
export class CurrencyConversionService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private exchangeRates: Map<string, Decimal> = new Map();

  constructor() {
    super('CurrencyConversionService');
  }

  async convert(
    amount: string,
    fromCurrency: string,
    toCurrency: string
  ): Promise<string> {
    if (fromCurrency === toCurrency) return amount;
    
    const rate = await this.getExchangeRate(fromCurrency, toCurrency);
    return new Decimal(amount).mul(rate).toString();
  }

  async getExchangeRate(from: string, to: string): Promise<Decimal> {
    // Implementation
  }
}
```

### 3.6 PriceProviderRegistry

```typescript
// packages/core/src/services/pricing/PriceProviderRegistry.ts
@Service()
export class PriceProviderRegistry extends BaseService {
  private providers: Map<string, IPriceProvider> = new Map();

  constructor() {
    super('PriceProviderRegistry');
    this.registerDefaultProviders();
  }

  register(name: string, provider: IPriceProvider): void {
    this.providers.set(name, provider);
  }

  getForToken(token: Token): IPriceProvider[] {
    // Return ordered list of providers that can handle this token
  }

  getProvider(name: string): IPriceProvider | undefined {
    return this.providers.get(name);
  }
}
```

### 3.7 New PricingService (Orchestration Only)

```typescript
// packages/core/src/services/pricing/PricingService.ts
@Service()
export class PricingService extends BaseService implements IPricingService {
  private readonly cache = Container.get(PriceCacheService);
  private readonly providers = Container.get(PriceProviderRegistry);
  private readonly rateLimiters = Container.get(RateLimiterRegistry);
  private readonly converter = Container.get(CurrencyConversionService);
  private readonly tokenRepository = Container.get(TokenRepository);

  constructor() {
    super('PricingService');
  }

  async getTokenPrice(
    token: Token,
    baseCurrency: string,
    timestamp?: Date
  ): Promise<string> {
    // 1. Check cache
    const cached = await this.cache.getCachedPrice(token.id, baseCurrency);
    if (cached) return cached.price;

    // 2. Fetch from providers
    const providers = this.providers.getForToken(token);
    for (const provider of providers) {
      const rateLimiter = this.rateLimiters.getForProvider(provider.name);
      await rateLimiter.waitForSlot();
      
      try {
        const price = await provider.fetchPrice(token, baseCurrency, timestamp);
        if (price) {
          await this.cache.cachePrice({
            tokenId: token.id,
            baseTokenId: baseCurrency,
            price,
            timestamp: timestamp || new Date(),
          });
          return price;
        }
      } catch (error) {
        this.logger.warn({ provider: provider.name, error }, 'Provider failed');
      }
    }

    throw new Error(`No price available for ${token.symbol}`);
  }

  async getCachedTokenPrices(
    tokens: Token[],
    baseCurrency: string,
    timestamp?: Date
  ): Promise<Map<string, string>> {
    // Implementation
  }
}
```

### 3.8 Update Imports Across Codebase

All files importing from old PricingService location need updating:

```typescript
// Before
import { PricingService } from '../services/PricingService';

// After
import { PricingService } from '../services/pricing';
// or
import { PricingService } from '../services/pricing/PricingService';
```

### 3.9 Deliverables

- [ ] Create `packages/core/src/services/pricing/` directory
- [ ] RateLimiterRegistry.ts created and tested
- [ ] PriceCacheService.ts created and tested
- [ ] CurrencyConversionService.ts created and tested
- [ ] PriceProviderRegistry.ts created and tested
- [ ] New PricingService.ts (orchestration only, < 300 lines)
- [ ] Interfaces for all new services
- [ ] Old PricingService.ts deleted
- [ ] All imports updated across codebase
- [ ] TypeScript compilation passes
- [ ] All tests pass

---

## Phase 4: Service Layer Cleanup

**Objective:** Remove all direct DB access from services, fix layer violations.

### 4.1 Fix Services Bypassing Repositories

**PortfolioValuationService:**

```typescript
// Before (direct DB)
const holdings = await db
  .select({...})
  .from(schema.holdings)
  .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
  .where(whereConditions);

// After (via repository)
const holdings = await this.holdingRepository.findByUserWithTokenDetails(userId, {
  accountId,
  includeHidden: false,
});
```

**PortfolioHistoryService:**

```typescript
// Before (raw SQL)
const result = await db.execute(sql`SELECT ... FROM ...`);

// After (via repository)
const events = await this.userPortfolioEventRepository.findByUserIdInDateRange(
  userId,
  startDate,
  endDate,
  { groupBy: 'day' }
);
```

**UserContextService:**

```typescript
// Before (direct DB)
const user = await db.query.users.findFirst({
  where: eq(schema.users.id, userId),
  with: { baseCurrency: true },
});

// After (via repository)
const user = await this.userRepository.findByIdWithBaseCurrency(userId);
```

**AgenticUserService:**

```typescript
// Remove all direct db and schema imports
// Use repositories for all operations
```

### 4.2 Fix Service → Use Case Dependency

**Problem:** DashboardService imports GetAssetAllocationUseCase

**Solution:** Extract shared logic to a service

```typescript
// Create new service
// packages/core/src/services/AssetAllocationService.ts
@Service()
export class AssetAllocationService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupRepository = Container.get(GroupRepository);

  async calculateFromHoldings(
    holdings: HoldingWithDetails[],
    priceMap: Map<string, string>
  ): Promise<AssetAllocation> {
    // Move calculation logic here
  }
}

// Update GetAssetAllocationUseCase to use service
@Service()
export class GetAssetAllocationUseCase implements IGetAssetAllocationUseCase {
  private readonly assetAllocationService = Container.get(AssetAllocationService);
  // ...
}

// Update DashboardService to use service
@Service()
export class DashboardService extends BaseService {
  private readonly assetAllocationService = Container.get(AssetAllocationService);
  // No longer imports use case!
}
```

### 4.3 Extract Shared Utilities

**Create shared module for extractPriceMap:**

```typescript
// packages/core/src/utils/portfolio-helpers.ts
import Decimal from 'decimal.js';
import type { PortfolioValueResult } from '../types';

export function extractPriceMap(portfolioValue: PortfolioValueResult): Map<string, string> {
  const priceMap = new Map<string, string>();
  
  for (const holding of portfolioValue.holdings) {
    const balance = new Decimal(holding.balance);
    const value = new Decimal(holding.value || '0');
    
    if (balance.greaterThan(0) && !priceMap.has(holding.tokenSymbol)) {
      priceMap.set(holding.tokenSymbol, value.div(balance).toString());
    }
  }
  
  return priceMap;
}

export function calculateTotalValue(holdings: HoldingValue[]): string {
  return holdings
    .reduce((sum, h) => sum.plus(h.value || '0'), new Decimal(0))
    .toString();
}
```

**Update all services to use shared utility:**

```typescript
// AccountService.ts, DashboardService.ts, etc.
import { extractPriceMap } from '../utils/portfolio-helpers';

// Remove private extractPriceMap method, use imported function
```

### 4.4 Standardize BaseService Usage

**Services not extending BaseService:**

1. PricingService → Fixed in Phase 3
2. PortfolioValuationService
3. PortfolioHistoryService
4. UserContextService
5. TokenValidationService

**For each:**

```typescript
// Before
@Service()
export class PortfolioValuationService {
  private readonly logger = createComponentLogger('portfolio-valuation');
}

// After
@Service()
export class PortfolioValuationService extends BaseService {
  constructor() {
    super('PortfolioValuationService');
  }
  // Now has: this.logger, this.withTransaction, this.validateRequiredFields, this.handleError
}
```

### 4.5 Deliverables

- [ ] PortfolioValuationService uses repositories only
- [ ] PortfolioHistoryService uses repositories only
- [ ] UserContextService uses repositories only
- [ ] AgenticUserService uses repositories only
- [ ] DashboardService no longer imports use case
- [ ] AssetAllocationService created
- [ ] extractPriceMap in shared utilities
- [ ] All services extend BaseService
- [ ] No service imports `db` or `schema` directly
- [ ] TypeScript compilation passes
- [ ] All tests pass

---

## Phase 5: Use Cases Refactor

**Objective:** Remove all direct DB access from use cases, use services/repositories only.

### 5.1 Refactor Pattern

For each use case that bypasses repositories:

```typescript
// Before (direct DB)
import { db } from "../database/connection";
import * as schema from "../database/schema";

const [newHolding] = await tx
  .insert(schema.holdings)
  .values(holdingData)
  .returning();

// After (via service with event)
import { HoldingService } from "../services/HoldingService";

const newHolding = await this.holdingService.createHoldingWithEvent({
  ...holdingData,
  eventContext: {
    baseCurrencyId: user.baseCurrencyId,
    tokenSymbol: token.symbol,
    tokenName: token.name,
    price: currentPrice,
  }
}, tx);
```

### 5.2 CreateHoldingUseCase Refactor

```typescript
@Service()
export class CreateHoldingUseCase extends BaseService implements ICreateHoldingUseCase {
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly holdingService = Container.get(HoldingService);
  private readonly pricingService = Container.get(PricingService);
  private readonly tokenService = Container.get(TokenService);

  constructor() {
    super('CreateHoldingUseCase');
  }

  async execute(input: CreateHoldingInput, user: User): Promise<CreateHoldingResult> {
    this.validateRequiredFields(input, ['accountId', 'tokenId', 'balance']);

    return await this.withTransaction(async (tx) => {
      // Validate account ownership via repository
      const account = await this.accountRepository.findByIdAndUser(
        input.accountId, 
        user.id, 
        tx
      );
      if (!account) {
        throw new NotFoundError('Account not found');
      }

      // Get token and price
      const token = await this.tokenService.findById(input.tokenId);
      const price = await this.pricingService.getTokenPrice(token, user.baseCurrencyId);

      // Create holding with event via service
      const holding = await this.holdingService.createHoldingWithEvent({
        accountId: input.accountId,
        userId: user.id,
        tokenId: input.tokenId,
        balance: input.balance,
        isActive: true,
        isHidden: false,
      }, {
        baseCurrencyId: user.baseCurrencyId,
        tokenSymbol: token.symbol,
        tokenName: token.name,
        price,
      }, tx);

      return { holding, price };
    });
  }
}
```

### 5.3 Import Use Cases Refactor

For ImportBinanceAccountsUseCase, ImportKrakenAccountsUseCase, ImportWalletAddressUseCase:

```typescript
@Service()
export class ImportBinanceAccountsUseCase extends BaseService implements IImportBinanceAccountsUseCase {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenService = Container.get(TokenService);
  private readonly integrationManager = Container.get(IntegrationManager);

  async execute(input: ImportInput, user: User): Promise<ImportResult> {
    // 1. Fetch external data (outside transaction)
    const integration = this.integrationManager.getIntegration('binance');
    const credentials = await this.getCredentials(user.id, input.institutionId);
    const externalAccounts = await integration.fetchAccounts(credentials);
    const externalHoldings = await integration.fetchHoldings(credentials);

    // 2. Process in transaction
    return await this.withTransaction(async (tx) => {
      // Find or create institution
      const institution = await this.institutionRepository.findOrCreate({
        name: 'Binance',
        institutionTypeId: 'exchange',
        // ...
      }, tx);

      // Upsert accounts
      const accounts = await this.accountRepository.upsertMany(
        externalAccounts.map(ea => ({
          userId: user.id,
          institutionId: institution.id,
          externalId: ea.id,
          name: ea.name,
          // ...
        })),
        ['userId', 'institutionId', 'externalId'],
        tx
      );

      // Create/update holdings with events
      const results = await Promise.all(
        externalHoldings.map(async (eh) => {
          const account = accounts.find(a => a.externalId === eh.accountId);
          const token = await this.tokenService.findOrCreateBySymbol(eh.symbol, 'crypto');
          
          return await this.holdingService.createOrUpdateHoldingWithEvent({
            accountId: account.id,
            userId: user.id,
            tokenId: token.id,
            balance: eh.balance,
          }, {
            baseCurrencyId: user.baseCurrencyId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
          }, tx);
        })
      );

      return { accounts, holdings: results };
    });
  }
}
```

### 5.4 Sync Use Cases Refactor

For SyncExchangeBalancesUseCase, SyncWalletBalancesUseCase:

```typescript
@Service()
export class SyncExchangeBalancesUseCase extends BaseService implements ISyncExchangeBalancesUseCase {
  private readonly holdingService = Container.get(HoldingService);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly integrationManager = Container.get(IntegrationManager);

  async execute(input: SyncInput): Promise<SyncResult> {
    // 1. Fetch external balances (outside transaction)
    const integration = this.integrationManager.getIntegration(input.exchangeType);
    const credentials = await this.getCredentials(input.userId, input.institutionId);
    const externalBalances = await integration.fetchBalances(credentials);

    // 2. Update in transaction
    return await this.withTransaction(async (tx) => {
      const updates: HoldingUpdate[] = [];
      const creates: HoldingCreate[] = [];

      // Compare with existing holdings
      const existingHoldings = await this.holdingService.findByAccount(
        input.accountId,
        tx
      );

      for (const external of externalBalances) {
        const existing = existingHoldings.find(h => h.tokenSymbol === external.symbol);
        
        if (existing) {
          if (existing.balance !== external.balance) {
            updates.push({
              id: existing.id,
              balance: external.balance,
            });
          }
        } else {
          creates.push({
            accountId: input.accountId,
            userId: input.userId,
            tokenSymbol: external.symbol,
            balance: external.balance,
          });
        }
      }

      // Batch update with events
      await this.holdingService.batchUpdateBalancesWithEvents(updates, {
        baseCurrencyId: input.baseCurrencyId,
      }, tx);

      // Create new holdings with events
      await this.holdingService.createManyHoldingsWithEvents(creates, {
        baseCurrencyId: input.baseCurrencyId,
      }, tx);

      return { updated: updates.length, created: creates.length };
    });
  }
}
```

### 5.5 UpdateHoldingsBatchUseCase Fix

Currently creates no events. After refactor:

```typescript
@Service()
export class UpdateHoldingsBatchUseCase extends BaseService implements IUpdateHoldingsBatchUseCase {
  private readonly holdingService = Container.get(HoldingService);

  async execute(input: BatchUpdateInput, user: User): Promise<BatchUpdateResult> {
    return await this.withTransaction(async (tx) => {
      // Now creates events for all updates
      await this.holdingService.batchUpdateBalancesWithEvents(
        input.updates,
        {
          baseCurrencyId: user.baseCurrencyId,
        },
        tx
      );

      return { updatedCount: input.updates.length };
    });
  }
}
```

### 5.6 Extend BaseService for All Use Cases

```typescript
// All use cases should follow this pattern
@Service()
export class SomeUseCase extends BaseService implements ISomeUseCase {
  constructor() {
    super('SomeUseCase');
  }

  async execute(input: Input, user: User): Promise<Result> {
    this.logger.debug({ input, userId: user.id }, 'Executing use case');
    this.validateRequiredFields(input, ['requiredField1', 'requiredField2']);
    
    try {
      return await this.withTransaction(async (tx) => {
        // Implementation
      });
    } catch (error) {
      throw this.handleError(error, 'Failed to execute use case');
    }
  }
}
```

### 5.7 Deliverables

- [ ] CreateHoldingUseCase refactored
- [ ] DeleteHoldingUseCase refactored
- [ ] UpdateHoldingUseCase refactored
- [ ] UpdateHoldingsBatchUseCase refactored (now creates events)
- [ ] ImportBinanceAccountsUseCase refactored
- [ ] ImportKrakenAccountsUseCase refactored
- [ ] ImportWalletAddressUseCase refactored
- [ ] SyncExchangeBalancesUseCase refactored
- [ ] SyncWalletBalancesUseCase refactored
- [ ] UpdateTokenPricesUseCase refactored
- [ ] All use cases extend BaseService
- [ ] No use case imports `db` or `schema` directly
- [ ] TypeScript compilation passes
- [ ] All tests pass

---

## Phase 6: Split Large Files

**Objective:** Break down oversized use cases into manageable, focused components.

### 6.1 ImportWalletAddressUseCase (823 lines)

Split into:

```
packages/core/src/use-cases/wallet-import/
├── index.ts
├── ImportWalletAddressUseCase.ts    # Orchestration (~150 lines)
├── ChainDetectionService.ts          # Detect chains for address
├── WalletTokenImporter.ts            # Import tokens for single chain
├── WalletMetadataService.ts          # Handle wallet metadata
└── interfaces/
    └── IWalletImport.ts
```

**ChainDetectionService:**

```typescript
@Service()
export class ChainDetectionService extends BaseService {
  private readonly blockchainMappingRepository = Container.get(InstitutionBlockchainMappingRepository);

  async detectChainsForAddress(address: string): Promise<ChainInfo[]> {
    // Move chain detection logic here
    const chains: ChainInfo[] = [];
    
    // Check Ethereum-compatible
    if (this.isEthereumAddress(address)) {
      chains.push(...await this.getEthereumCompatibleChains());
    }
    
    // Check Solana
    if (this.isSolanaAddress(address)) {
      chains.push({ chainId: 'solana', name: 'Solana' });
    }
    
    // ... other chains
    
    return chains;
  }
}
```

**WalletTokenImporter:**

```typescript
@Service()
export class WalletTokenImporter extends BaseService {
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenService = Container.get(TokenService);
  private readonly blockchainService = Container.get(BlockchainService);

  async importTokensForChain(
    walletAddress: string,
    chainId: string,
    accountId: string,
    userId: string,
    eventContext: EventContext,
    transaction: DatabaseTransaction
  ): Promise<ImportedToken[]> {
    // Move token import logic here
    const balances = await this.blockchainService.fetchBalances(walletAddress, chainId);
    
    const results: ImportedToken[] = [];
    for (const balance of balances) {
      const token = await this.tokenService.findOrCreateByContract(
        balance.contractAddress,
        chainId
      );
      
      const holding = await this.holdingService.createOrUpdateHoldingWithEvent({
        accountId,
        userId,
        tokenId: token.id,
        balance: balance.amount,
      }, eventContext, transaction);
      
      results.push({ token, holding, balance: balance.amount });
    }
    
    return results;
  }
}
```

**New ImportWalletAddressUseCase (orchestration only):**

```typescript
@Service()
export class ImportWalletAddressUseCase extends BaseService implements IImportWalletAddressUseCase {
  private readonly chainDetection = Container.get(ChainDetectionService);
  private readonly tokenImporter = Container.get(WalletTokenImporter);
  private readonly walletMetadata = Container.get(WalletMetadataService);
  private readonly userWalletRepository = Container.get(UserWalletRepository);
  private readonly accountRepository = Container.get(AccountRepository);

  async execute(input: ImportWalletInput, user: User): Promise<ImportWalletResult> {
    this.logger.info({ address: input.address, userId: user.id }, 'Starting wallet import');

    // 1. Detect chains (outside transaction)
    const chains = await this.chainDetection.detectChainsForAddress(input.address);
    
    if (chains.length === 0) {
      throw new ValidationError('No supported chains found for address');
    }

    // 2. Process in transaction
    return await this.withTransaction(async (tx) => {
      // Create/update wallet record
      const wallet = await this.userWalletRepository.upsert({
        userId: user.id,
        walletAddress: input.address,
        institutionIds: chains.map(c => c.institutionId),
      }, tx);

      // Import tokens for each chain
      const importResults: ChainImportResult[] = [];
      for (const chain of chains) {
        const account = await this.getOrCreateAccount(user.id, chain, tx);
        
        const tokens = await this.tokenImporter.importTokensForChain(
          input.address,
          chain.chainId,
          account.id,
          user.id,
          { baseCurrencyId: user.baseCurrencyId },
          tx
        );
        
        importResults.push({ chain, account, tokens });
      }

      return { wallet, imports: importResults };
    });
  }
}
```

### 6.2 SyncExchangeBalancesUseCase (562 lines)

Split into:

```
packages/core/src/use-cases/sync/
├── index.ts
├── SyncExchangeBalancesUseCase.ts   # Orchestration (~150 lines)
├── ExchangeBalanceFetcher.ts         # Fetch from exchange APIs
├── BalanceDiffCalculator.ts          # Calculate what changed
├── BatchHoldingUpdater.ts            # Apply updates
└── interfaces/
    └── ISync.ts
```

### 6.3 SyncWalletBalancesUseCase (551 lines)

Similar split to SyncExchangeBalancesUseCase:

```
packages/core/src/use-cases/sync/
├── SyncWalletBalancesUseCase.ts     # Orchestration (~150 lines)
├── BlockchainBalanceFetcher.ts       # Fetch from blockchain
├── BalanceDiffCalculator.ts          # Shared with exchange sync
└── BatchHoldingUpdater.ts            # Shared with exchange sync
```

### 6.4 Deliverables

- [ ] ImportWalletAddressUseCase split into 4 files
- [ ] SyncExchangeBalancesUseCase split into 4 files
- [ ] SyncWalletBalancesUseCase split (shares components with exchange)
- [ ] All new components have interfaces
- [ ] All new components extend BaseService
- [ ] No file > 300 lines
- [ ] TypeScript compilation passes
- [ ] All tests pass

---

## Phase 7: Standardization

**Objective:** Apply consistent patterns across entire codebase.

### 7.1 Standardize Return Types

**Decision: Use `null` for "not found"**

```typescript
// All repositories
async findById(id: string): Promise<Entity | null>;
async findByUser(userId: string): Promise<Entity[]>;

// Never undefined for single-entity lookups
```

Update all repositories:
- [ ] UserWalletRepository.findByUserAndAddress → returns `null` not `undefined`
- [ ] All other inconsistent methods

### 7.2 Standardize Method Naming

**Conventions:**

| Operation | Pattern | Example |
|-----------|---------|---------|
| Get single by ID | `findById` | `findById(id)` |
| Get single by criteria | `findBy*` | `findByEmail(email)` |
| Get multiple | `findAll*` | `findAllByUser(userId)` |
| Create | `create` | `create(data)` |
| Create with event | `createWithEvent` | `createWithEvent(data, context)` |
| Update | `update` | `update(id, data)` |
| Delete | `delete` | `delete(id)` |
| Check existence | `exists` | `exists(id)` |
| Count | `count` | `countByUser(userId)` |

### 7.3 Add Missing Database Index

```sql
-- Migration: Add index on api_keys.key_hash
CREATE INDEX idx_api_keys_key_hash ON api_keys (key_hash);
```

### 7.4 Fix Naming Inconsistency

```sql
-- Migration: Rename lastUpdated to updatedAt on holdings
ALTER TABLE holdings RENAME COLUMN last_updated TO updated_at;
```

Update schema.ts accordingly.

### 7.5 Fix Raw SQL Queries

**UserPortfolioEventRepository:**

```typescript
// Before (raw SQL)
const results = await database.execute<HoldingRow>(sql`
  SELECT h.user_id, h.id as holding_id, ...
  FROM holdings h
  JOIN accounts a ON a.id = h.account_id
`);

// After (Drizzle ORM)
const results = await database
  .select({
    userId: schema.holdings.userId,
    holdingId: schema.holdings.id,
    // ... properly typed
  })
  .from(schema.holdings)
  .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
  .where(...);
```

### 7.6 Fix JSONB Filtering

**UserWalletRepository:**

```typescript
// Before (in-memory filtering)
const results = await database.select().from(schema.userWallets)...
return results.filter((wallet) => {
  return wallet.institutionIds?.includes(institutionId);
});

// After (PostgreSQL @> operator)
async findByInstitution(institutionId: string): Promise<UserWallet[]> {
  return await this.getDb()
    .select()
    .from(schema.userWallets)
    .where(
      sql`${schema.userWallets.institutionIds} @> ${JSON.stringify([institutionId])}::jsonb`
    );
}
```

### 7.7 Deliverables

- [ ] All return types standardized to `null` for not-found
- [ ] All method names follow naming convention
- [ ] api_keys.key_hash index added
- [ ] holdings.lastUpdated renamed to updatedAt
- [ ] All raw SQL replaced with Drizzle ORM queries
- [ ] JSONB filtering uses PostgreSQL operators
- [ ] TypeScript compilation passes
- [ ] All tests pass

---

## Phase 8: Cleanup & Validation

**Objective:** Remove dead code, validate architecture, update documentation.

### 8.1 Remove Unused Imports

Run across codebase:
- Remove all unused `import { db }` statements
- Remove all unused `import * as schema` statements
- Use linter to find and remove other unused imports

### 8.2 Delete Deprecated Code

- [ ] Remove old PricingService.ts (replaced in Phase 3)
- [ ] Remove any duplicate utility functions
- [ ] Remove commented-out code blocks

### 8.3 Validate Architecture

**Create validation script:**

```typescript
// scripts/validate-architecture.ts
import * as ts from 'typescript';
import * as glob from 'glob';

// Check that no use-case or service imports db/schema directly
const forbidden = ['../database/connection', '../database/schema'];

const useCaseFiles = glob.sync('packages/core/src/use-cases/**/*.ts');
const serviceFiles = glob.sync('packages/core/src/services/**/*.ts');

for (const file of [...useCaseFiles, ...serviceFiles]) {
  // Skip repository files
  if (file.includes('/repositories/')) continue;
  
  const content = fs.readFileSync(file, 'utf-8');
  for (const pattern of forbidden) {
    if (content.includes(pattern)) {
      console.error(`VIOLATION: ${file} imports ${pattern}`);
      process.exit(1);
    }
  }
}

console.log('Architecture validation passed!');
```

### 8.4 Update Copilot Instructions

Update `.github/copilot-instructions.md`:

```markdown
### Architecture Rules (ENFORCED)

- ❌ **NEVER import `db` or `schema` in use-cases or services**
- ✅ All data access MUST go through repositories
- ✅ All holding mutations MUST use HoldingService methods that create events
- ✅ All services MUST extend BaseService
- ✅ All use cases MUST extend BaseService
- ✅ All layers MUST have interfaces
```

### 8.5 Create Architecture Documentation

Update `docs/ARCHITECTURE.md`:

```markdown
## Layer Rules

### Use Cases
- Orchestrate business operations
- Use services and repositories only
- NEVER import db or schema
- Extend BaseService

### Services
- Contain business logic
- Use repositories only
- NEVER import db or schema
- Extend BaseService

### Repositories
- ONLY layer that accesses database
- Implement interfaces
- Extend BaseRepository
- Handle events for mutations
```

### 8.6 Final Validation Checklist

- [ ] `bun lint` passes with no errors
- [ ] `bun type-check` passes with no errors
- [ ] All tests pass
- [ ] Architecture validation script passes
- [ ] No use case imports db/schema
- [ ] No service imports db/schema
- [ ] All classes have interfaces
- [ ] All services extend BaseService
- [ ] All use cases extend BaseService
- [ ] No file > 300 lines (except BaseRepository)
- [ ] All holding mutations create events
- [ ] Documentation updated

### 8.7 Deliverables

- [ ] All unused imports removed
- [ ] Deprecated code deleted
- [ ] Architecture validation script created and passing
- [ ] Copilot instructions updated
- [ ] ARCHITECTURE.md updated
- [ ] Final validation checklist complete

---

## Summary

### Phase Dependencies

```
Phase 1: Foundation (Interfaces)
    ↓ (required for type safety)
Phase 2: Repository Completion
    ↓ (required for service/use-case refactor)
Phase 3: PricingService Split
    ↓ (can run in parallel with Phase 4)
Phase 4: Service Layer Fix
    ↓ (required for use-case refactor)
Phase 5: Use Cases Refactor
    ↓ (can run in parallel with Phase 6)
Phase 6: Large Files Split
    ↓ (required before standardization)
Phase 7: Standardization
    ↓ (required before cleanup)
Phase 8: Cleanup & Validation
```

### Expected Outcomes

After completing all phases:

| Metric | Before | After |
|--------|--------|-------|
| Use cases with direct DB | 64% | 0% |
| Services with direct DB | 24% | 0% |
| Files > 300 lines | 8 | 0 |
| Interfaces defined | 0% | 100% |
| Extends BaseService | 38% | 100% |
| Files to modify for new event | 11+ | 1 |
| Architecture score | 6.6/10 | 9.0/10 |

### Key Principles

1. **Repository as Single Point of Data Access**: All DB operations through repositories
2. **Event Creation in Repository**: Mutations automatically create portfolio events
3. **Interfaces at All Layers**: Enable mocking and substitution
4. **BaseService Everywhere**: Consistent logging, validation, error handling
5. **Small, Focused Files**: No file > 300 lines
6. **Layer Direction**: Presentation → Use Cases → Services → Repositories → Database

---

**Document Status:** Complete Implementation Plan  
**Related Document:** [ARCHITECTURE_ANALYSIS_CONSOLIDATED.md](./ARCHITECTURE_ANALYSIS_CONSOLIDATED.md)
