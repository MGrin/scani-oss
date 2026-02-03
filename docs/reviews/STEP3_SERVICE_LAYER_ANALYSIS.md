# Step 3: Service Layer Analysis

**Date:** Analysis performed on existing codebase  
**Scope:** `packages/core/src/services/` - All service classes  
**Overall Score:** 6.0/10

---

## Executive Summary

The service layer provides business logic orchestration with good patterns for logging, validation, and error handling via `BaseService`. However, there are significant issues: **services bypass repositories** (same issue as use-cases), **duplicate code** across services, **God-class tendencies** (PricingService: 2059 lines), and **inconsistent dependency injection patterns**. Some services correctly delegate to repositories, while others directly import `db` and `schema`.

---

## 1. Inventory

### 1.1 Service Files

| Service | Lines | Extends BaseService | Direct DB Access | Key Responsibilities |
|---------|-------|---------------------|------------------|---------------------|
| `BaseService.ts` | 214 | N/A (base class) | ✅ via `getDb()` | Logging, transactions, validation |
| `HoldingService.ts` | 893 | ✅ Yes | ❌ Uses repos | Holding CRUD with event tracking |
| `AccountService.ts` | 317 | ✅ Yes | ❌ Uses repos | Account CRUD, summaries |
| `TokenService.ts` | 836 | ✅ Yes | ❌ Uses repos | Token CRUD, provider integration |
| `PricingService.ts` | **2059** | ❌ No | ✅ Direct | Price fetching, caching, providers |
| `PortfolioValuationService.ts` | 265 | ❌ No | ✅ Direct | Portfolio value calculations |
| `PortfolioHistoryService.ts` | 655 | ❌ No | ✅ Direct | Historical portfolio data |
| `DashboardService.ts` | 250 | ✅ Yes | ❌ Uses repos | Dashboard overview aggregation |
| `InstitutionService.ts` | 181 | ✅ Yes | ❌ Uses repos | Institution CRUD |
| `UserService.ts` | 40 | ✅ Yes | ❌ Uses repos | User updates |
| `UserContextService.ts` | 120 | ❌ No | ✅ Direct | User context, base currency |
| `UserPortfolioEventService.ts` | 269 | ✅ Yes | ❌ Uses repos | Portfolio event creation |
| `AgenticUserService.ts` | 218 | ✅ Yes | ✅ Direct | Agentic user management |
| `ApiKeyService.ts` | 211 | ✅ Yes | ❌ Uses repos | API key management |
| `UserWalletService.ts` | 169 | ✅ Yes | ❌ Uses repos | Wallet management |
| `IntegrationCredentialsService.ts` | 239 | ✅ Yes | ❌ Uses repos | Credential encryption/storage |
| `TokenValidationService.ts` | 611 | ❌ No | ❌ Uses repos | External token validation |
| `ScamTokenDetectionService.ts` | 261 | ✅ Yes | ❌ N/A | Scam probability calculation |
| `AIService.ts` | 190 | ✅ Yes | ❌ Uses service | Screenshot parsing orchestration |
| `EnumServices.ts` | ~80 | ✅ Yes | ❌ Uses repos | Institution/Account types |
| `PortfolioHistoryRefreshService.ts` | ~150 | ✅ Yes | ❌ Uses repos | History refresh orchestration |

**Total:** 21 services (19 concrete + 2 enum services in one file)

### 1.2 Services Bypassing Repositories

| Service | Issue | Direct Import |
|---------|-------|---------------|
| `PricingService.ts` | Direct `db` import | `import { db } from '../database/connection'` |
| `PortfolioValuationService.ts` | Direct `db` + `schema` | Both imports |
| `PortfolioHistoryService.ts` | Direct `db` import | `import { db } from '../database/connection'` |
| `UserContextService.ts` | Direct `db` + `schema` | Both imports |
| `AgenticUserService.ts` | Direct `db` + `schema` | Both imports |

---

## 2. Architectural Patterns Analysis

### 2.1 ✅ What's Good

#### 2.1.1 BaseService Pattern
Provides excellent foundation:
```typescript
export abstract class BaseService {
  protected readonly logger: CustomLogger;
  
  protected async withTransaction<T>(callback): Promise<T>;
  protected validateRequiredFields<T>(data: T, requiredFields: (keyof T)[]): void;
  protected handleError(error: unknown, context: string): Error;
}
```

**Benefits:**
- Consistent logging across all services
- Transaction wrapper for complex operations
- Validation helpers
- Standardized error handling

#### 2.1.2 TypeDI for Service Dependencies
Services properly use `Container.get()`:
```typescript
@Service()
export class HoldingService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  // ...
}
```

#### 2.1.3 HoldingService - Event-Driven Pattern
Well-designed methods for event tracking:
```typescript
async createHoldingWithEvent(input: CreateHoldingWithEventInput, transaction?: DatabaseTransaction): Promise<Holding> {
  // Create holding via repository
  const holding = await this.holdingRepository.create({...}, transaction);
  
  // Create event if context provided
  if (input.eventContext) {
    await this.userPortfolioEventService.createHoldingCreateEvent({...}, transaction);
  }
  return holding;
}
```

**Why this is good:**
- Atomic operations (single transaction)
- Optional event tracking (caller decides)
- Proper delegation to repository

#### 2.1.4 Encryption in IntegrationCredentialsService
Proper security pattern:
```typescript
async storeCredentials(userId: string, institutionId: string, credentials: Record<string, unknown>): Promise<UserIntegrationCredentials> {
  const encrypted = encryptCredentials(credentials);  // Encrypt before storing
  // ...store via repository
}
```

#### 2.1.5 ScamTokenDetectionService - Pure Business Logic
No database access, pure domain logic:
```typescript
@Service()
export class ScamTokenDetectionService extends BaseService {
  calculateScamProbability(symbol: string, name: string, createdAt: Date, hasPriceData: boolean): number {
    // Pure calculation logic with heuristics
    // No DB access - exactly what a service should do
  }
}
```

### 2.2 ❌ What's Bad

#### 2.2.1 **God Class: PricingService (2059 lines)**

**Symptoms:**
- 2059 lines of code
- Handles: rate limiting, caching, provider management, currency conversion, price fetching, error handling, fallback logic
- Multiple global rate limiters defined at module level
- Complex provider orchestration

**SRP Violations:**
```typescript
// PricingService does too many things:
- Rate limiting management
- Provider registry
- Cache management  
- Currency conversion
- Price fetching
- Failure handling
- Token grouping by provider
```

**Recommendation:** Split into:
- `RateLimiterService` - Rate limit management
- `PricingProviderRegistry` - Provider management
- `PriceCache` - Caching logic
- `CurrencyConversionService` - Currency rates
- `PricingOrchestrator` - High-level orchestration

#### 2.2.2 **Repository Bypass (Same as Use-Cases)**

5 services directly import `db` and `schema`:

```typescript
// PortfolioValuationService.ts
import { db } from '../database/connection';
import * as schema from '../database/schema';

// Direct query instead of repository
const holdings = await db
  .select({...})
  .from(schema.holdings)
  .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
  .where(whereConditions);
```

**Why bad:** Same issues as repositories - can't test, can't swap persistence, duplicated queries.

#### 2.2.3 **Duplicate Code: extractPriceMap**

Same method in multiple services:
```typescript
// AccountService.ts (lines 39-52)
private extractPriceMap(portfolioValue: {...}): Map<string, string> {
  const priceMap = new Map<string, string>();
  for (const portfolioHolding of portfolioValue.holdings) {
    // ... exact same logic
  }
}

// DashboardService.ts (lines 92-102) - Same code with comment:
// "Note: This method is duplicated in AccountService - this is intentional
// to keep services independent and avoid cross-service dependencies."
```

**Why bad:** 
- DRY violation (acknowledged but not addressed)
- When logic changes, must update multiple places
- "Intentional" duplication is still tech debt

#### 2.2.4 **Inconsistent BaseService Usage**

Some services don't extend `BaseService`:
```typescript
// PricingService - No BaseService, creates own logger
@Service()
export class PricingService {
  private readonly logger = createComponentLogger('pricing');
  // Missing: withTransaction, validateRequiredFields, handleError
}

// PortfolioValuationService - Same issue
@Service()
export class PortfolioValuationService {
  private readonly logger = createComponentLogger('portfolio-valuation');
}

// UserContextService - Doesn't even have logger
@Service()
export class UserContextService {
  // No logging at all
}
```

#### 2.2.5 **Service Depends on Use-Case**

Violates layer direction:
```typescript
// DashboardService.ts
import { GetAssetAllocationUseCase } from '../use-cases/GetAssetAllocationUseCase';

@Service()
export class DashboardService extends BaseService {
  private readonly assetAllocationUseCase = Container.get(GetAssetAllocationUseCase);
}
```

**Why bad:** In clean architecture, use-cases call services, not the other way around. This creates circular dependency potential.

#### 2.2.6 **Inconsistent Method Naming**

```typescript
// Some use get*
getUserPortfolioValue()
getTokenPrice()
getHistoryEvents()

// Some use find*
findByUserId()  // (in repository)

// Some use create*
createHolding()
createHoldingWithEvent()

// Some use update*
updateHolding()
updateHoldingBalance()

// Mixed conventions
storeCredentials()  // not createCredentials()
revokeApiKey()      // not deleteApiKey()
```

#### 2.2.7 **Raw SQL in PortfolioHistoryService**

```typescript
// PortfolioHistoryService.ts - Legacy fallback with raw SQL
const result = await db.execute(sql`
  SELECT timestamp, total_value, holdings_count
  FROM (
    SELECT timestamp, 
           SUM(value) as total_value,
           COUNT(DISTINCT holding_id) as holdings_count
    FROM ...
  ) ...
`);
```

**Issues:**
- No type safety
- Column names in snake_case don't match TypeScript
- Complex JOIN logic that should be in repository

---

## 3. Service Dependency Graph

```
┌──────────────────────────────────────────────────────────────────────┐
│                        PRESENTATION LAYER                             │
│                         (tRPC Routers)                                │
│                              │                                        │
├──────────────────────────────┼────────────────────────────────────────┤
│                              ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                     SERVICE LAYER                                │ │
│  │                                                                  │ │
│  │  ┌────────────────┐    ┌──────────────────────────────────────┐ │ │
│  │  │ DashboardSvc   │───▶│ GetAssetAllocationUseCase (WRONG!)   │ │ │
│  │  └───────┬────────┘    └──────────────────────────────────────┘ │ │
│  │          │                                                       │ │
│  │          ▼                                                       │ │
│  │  ┌────────────────┐    ┌─────────────────┐                      │ │
│  │  │PortfolioValue  │───▶│ PricingService  │──┐                   │ │
│  │  │    Service     │    │  (2059 lines!)  │  │                   │ │
│  │  └───────┬────────┘    └────────┬────────┘  │                   │ │
│  │          │                      │           │                   │ │
│  │          ▼                      ▼           │                   │ │
│  │  ┌────────────────┐    ┌─────────────────┐ │                   │ │
│  │  │ UserContext    │    │TokenValidation  │◀┘                   │ │
│  │  │   Service      │    │    Service      │                      │ │
│  │  └───────┬────────┘    └────────┬────────┘                      │ │
│  │          │                      │                               │ │
│  │      ┌───┴────────────┬─────────┘                               │ │
│  │      │                │                                         │ │
│  │      ▼                ▼                                         │ │
│  │  Direct DB        Repository                                    │ │
│  │   Access!          Access ✓                                     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                              │                                        │
├──────────────────────────────┼────────────────────────────────────────┤
│                              ▼                                        │
│                      REPOSITORY LAYER                                 │
│                    (Should be ONLY here)                              │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. SOLID Principles Assessment

| Principle | Score | Notes |
|-----------|-------|-------|
| **S**ingle Responsibility | 4/10 | PricingService is a God class (2059 lines); many services do too much |
| **O**pen/Closed | 6/10 | Provider pattern in PricingService is good, but services need modification for new features |
| **L**iskov Substitution | 7/10 | Services can be substituted (when interfaces exist) |
| **I**nterface Segregation | 4/10 | No service interfaces defined; clients depend on full implementations |
| **D**ependency Inversion | 5/10 | Some services use repositories, some bypass directly to DB |

---

## 5. Specific Issues Catalog

### 5.1 High Priority Issues

| ID | Issue | File(s) | Impact |
|----|-------|---------|--------|
| S-001 | God class PricingService | `PricingService.ts` | 2059 lines, unmaintainable |
| S-002 | Services bypass repositories | 5 service files | Architecture violation |
| S-003 | Service depends on use-case | `DashboardService.ts` | Inverted layer dependency |
| S-004 | No service interfaces | All services | Can't mock, tight coupling |

### 5.2 Medium Priority Issues

| ID | Issue | File(s) | Impact |
|----|-------|---------|--------|
| S-005 | Duplicate extractPriceMap | `AccountService.ts`, `DashboardService.ts` | DRY violation |
| S-006 | Inconsistent BaseService usage | 4 services | Missing logging/validation |
| S-007 | Raw SQL in services | `PortfolioHistoryService.ts` | Type safety loss |
| S-008 | Global rate limiters at module level | `PricingService.ts` | Hidden global state |

### 5.3 Low Priority Issues

| ID | Issue | File(s) | Impact |
|----|-------|---------|--------|
| S-009 | Inconsistent method naming | Multiple services | Code readability |
| S-010 | Some services very thin | `UserService.ts` (40 lines) | Questionable value-add |

---

## 6. Recommendations

### 6.1 Immediate Actions (High Priority)

#### 6.1.1 Split PricingService into Focused Services

```typescript
// 1. RateLimiterRegistry - Manage all rate limiters
@Service()
export class RateLimiterRegistry {
  readonly coinGecko = new RateLimiter(10, 60_000);
  readonly finnhub = new RateLimiter(50, 60_000);
  // ...
}

// 2. PriceCache - Price caching logic
@Service()
export class PriceCache {
  async getCachedPrice(tokenId: string, baseCurrencyId: string): Promise<CachedPrice | null>;
  async cachePrice(price: TokenPrice): Promise<void>;
}

// 3. CurrencyConversionService - Currency rates
@Service()
export class CurrencyConversionService {
  async convertPrice(amount: string, from: string, to: string): Promise<string>;
}

// 4. PricingService - Orchestration only (~300 lines)
@Service()
export class PricingService {
  constructor(
    private cache: PriceCache,
    private rateLimiters: RateLimiterRegistry,
    private currencyConverter: CurrencyConversionService,
    private providers: PricingProviderRegistry,
  ) {}
}
```

#### 6.1.2 Create Service Interfaces

```typescript
// packages/core/src/services/interfaces/IPricingService.ts
export interface IPricingService {
  getTokenPrice(token: Token, baseCurrency: string, timestamp: Date): Promise<string>;
  getCachedTokenPrices(tokens: Token[], baseCurrency: string, timestamp: Date): Promise<Map<string, string>>;
}

// Implementation
@Service()
export class PricingService implements IPricingService { }
```

#### 6.1.3 Fix Repository Bypasses

Move all direct DB queries to repositories:

```typescript
// BEFORE (PortfolioValuationService.ts)
const holdings = await db
  .select({...})
  .from(schema.holdings)
  .innerJoin(schema.tokens, ...)
  .where(...);

// AFTER
// Add method to HoldingRepository:
async findActiveHoldingsWithTokens(userId: string, accountId?: string): Promise<HoldingWithToken[]>;

// Service uses repository:
const holdings = await this.holdingRepository.findActiveHoldingsWithTokens(userId, accountId);
```

#### 6.1.4 Fix Service → Use-Case Dependency

```typescript
// BEFORE: DashboardService depends on use-case
private readonly assetAllocationUseCase = Container.get(GetAssetAllocationUseCase);

// AFTER: Extract shared logic to service
@Service()
export class AssetAllocationService {
  calculateFromFetchedData(...): AssetAllocation;
}

// Use-case and DashboardService both use the service
@Service()
export class GetAssetAllocationUseCase {
  constructor(private assetAllocationService: AssetAllocationService) {}
}
```

### 6.2 Short-Term Improvements (Medium Priority)

#### 6.2.1 Extract Shared Methods

```typescript
// packages/core/src/services/shared/price-utils.ts
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

// Services import from shared
import { extractPriceMap } from './shared/price-utils';
```

#### 6.2.2 Standardize BaseService Usage

```typescript
// All services should extend BaseService
@Service()
export class PricingService extends BaseService {  // Add extends
  constructor() {
    super('PricingService');  // Add super call
  }
}
```

### 6.3 Long-Term Improvements (Low Priority)

#### 6.3.1 Consider CQRS for Complex Queries

Separate read (query) and write (command) operations:

```typescript
// Query service - read-only, optimized for reads
@Service()
export class PortfolioQueryService {
  async getPortfolioValue(userId: string): Promise<PortfolioValueResult>;
  async getDashboardOverview(userId: string): Promise<DashboardOverview>;
}

// Command service - write operations
@Service()
export class PortfolioCommandService {
  async createHolding(input: CreateHoldingInput): Promise<Holding>;
  async updateHoldingBalance(input: UpdateBalanceInput): Promise<void>;
}
```

#### 6.3.2 Event-Driven Architecture

For cross-cutting concerns like portfolio events:

```typescript
// Domain event
interface HoldingCreatedEvent {
  holdingId: string;
  userId: string;
  tokenId: string;
  balance: string;
}

// Event handler (separate from holding creation)
@Service()
export class PortfolioEventHandler {
  @OnEvent('holding.created')
  async handleHoldingCreated(event: HoldingCreatedEvent): Promise<void> {
    await this.portfolioEventService.createHoldingCreateEvent(event);
  }
}
```

---

## 7. Service Layer Metrics

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Average service size | 391 lines | < 300 lines | ❌ Over |
| Max service size | 2059 lines | < 500 lines | ❌ Critical |
| Services extending BaseService | 15/21 (71%) | 100% | ⚠️ Needs work |
| Services with direct DB access | 5/21 (24%) | 0% | ❌ Violations |
| Services with interfaces | 0/21 (0%) | 100% | ❌ Missing |

---

## 8. Summary

### Strengths
1. `BaseService` provides good foundation (logging, validation, transactions)
2. `HoldingService` demonstrates proper event-driven patterns
3. `ScamTokenDetectionService` is pure domain logic (no DB)
4. TypeDI integration is consistent

### Critical Weaknesses
1. **PricingService is a 2059-line God class** - needs immediate splitting
2. **5 services bypass repositories** - same issue as use-cases layer
3. **Service depends on use-case** - inverted layer dependency
4. **No service interfaces** - can't mock or swap implementations
5. **Duplicate code** - extractPriceMap duplicated and acknowledged

### Root Cause Analysis
The service layer tries to do too much:
- Business logic (good)
- Data access (should be in repos)
- Complex orchestration (should be in use-cases)
- External API calls (good, but too much in one class)

### Next Steps
1. **Split PricingService** into 4-5 focused services
2. **Create service interfaces** for all services
3. **Move DB queries** from services to repositories
4. **Fix layer violation** where DashboardService depends on use-case

---

**Document Status:** Complete  
**Next Analysis:** Step 4 - Use Cases Layer Analysis
