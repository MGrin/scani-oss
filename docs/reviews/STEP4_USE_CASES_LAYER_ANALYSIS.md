# Step 4: Use Cases Layer Analysis

**Date:** Analysis performed on existing codebase  
**Scope:** `packages/core/src/use-cases/` - All use case classes  
**Overall Score:** 5.5/10

---

## Executive Summary

The use-cases layer represents complex business operations that coordinate multiple services and repositories. While the structure follows the use-case pattern (single `execute()` method), **nearly all use-cases bypass the repository pattern** by directly importing `db` and `schema`. This is the **root cause of your original pain point** - adding cross-cutting concerns (like portfolio events) requires modifying every use-case instead of a single repository method.

---

## 1. Inventory

### 1.1 Use Case Files

| Use Case | Lines | Direct DB Access | BaseService | Purpose |
|----------|-------|------------------|-------------|---------|
| `CreateHoldingUseCase.ts` | 341 | ✅ `db` + `schema` | ❌ No | Create holding with validation and pricing |
| `DeleteHoldingUseCase.ts` | 222 | ✅ `db` + `schema` | ❌ No | Delete/hide holding with event creation |
| `UpdateHoldingUseCase.ts` | 141 | ✅ `db` + `schema` | ❌ No | Update holding balance with events |
| `UpdateHoldingsBatchUseCase.ts` | 112 | ✅ `schema` only | ❌ No | Batch update holdings |
| `ImportBinanceAccountsUseCase.ts` | 430 | ✅ `db` + `schema` | ❌ No | Import Binance accounts/holdings |
| `ImportKrakenAccountsUseCase.ts` | ~400 | ✅ `db` + `schema` | ❌ No | Import Kraken accounts/holdings |
| `ImportWalletAddressUseCase.ts` | 823 | ✅ `db` + `schema` | ❌ No | Import wallet across chains |
| `SyncExchangeBalancesUseCase.ts` | 562 | ✅ `db` + `schema` | ❌ No | Cron: sync exchange balances |
| `SyncWalletBalancesUseCase.ts` | 551 | ✅ `db` + `schema` | ❌ No | Cron: sync blockchain balances |
| `GetAssetAllocationUseCase.ts` | 370 | ❌ Uses repos | ✅ Yes | Calculate asset allocation |
| `ParseScreenshotUseCase.ts` | 350 | ❌ Uses repos | ❌ No | AI screenshot parsing + enrichment |
| `UpdateHoldingPriceUseCase.ts` | 163 | ❌ Uses repos | ❌ No | Force price refresh for holding |
| `CreateHoldingsWithDependenciesUseCase.ts` | 215 | ❌ Uses services | ❌ No | Create holding + institution + account |
| `UpdateTokenPricesUseCase.ts` | ~100 | ✅ Direct | ❌ No | Cron: update all token prices |

**Total:** 14 use cases

### 1.2 Direct Database Access Summary

| Category | Count | % |
|----------|-------|---|
| Use cases with direct `db` import | 9 | 64% |
| Use cases with direct `schema` import | 10 | 71% |
| Use cases using only repos/services | 4 | 29% |

---

## 2. Architectural Patterns Analysis

### 2.1 ✅ What's Good

#### 2.1.1 Single Responsibility per Use Case
Each use case has a clear, focused purpose:
```typescript
// CreateHoldingUseCase - one job: create a holding
// DeleteHoldingUseCase - one job: delete/hide a holding
// SyncExchangeBalancesUseCase - one job: sync exchange balances
```

#### 2.1.2 Transaction Handling with `withTransaction`
Good use of transactional helper:
```typescript
const holding = await withTransaction(
  async (tx) => {
    // All DB operations in single transaction
    const [account] = await tx.select()...
    const [newHolding] = await tx.insert(schema.holdings)...
    return newHolding;
  },
  { name: 'create-holding', timeout: 10000 }
);
```

#### 2.1.3 External API Separation
Correctly separates external API calls from DB transactions:
```typescript
// STEP 1: Fetch ALL external data first (no DB connections held during API calls)
const accountsResult = await integration.fetchAccounts(credentials);
const holdingsResult = await integration.fetchHoldings(accountInfo.externalId, credentials);

// STEP 2: Process ALL database operations in single transaction
await withTransaction(async (tx) => {
  // All DB operations here
});
```

This is excellent for preventing connection exhaustion.

#### 2.1.4 TypeDI Integration
Consistent use of `Container.get()`:
```typescript
@Service()
export class CreateHoldingUseCase {
  private readonly pricingService = Container.get(PricingService);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly userPortfolioEventService = Container.get(UserPortfolioEventService);
}
```

#### 2.1.5 GetAssetAllocationUseCase - Proper Pattern
Extends `BaseService` and uses repositories:
```typescript
@Service()
export class GetAssetAllocationUseCase extends BaseService {
  private readonly portfolioService = Container.get(PortfolioValuationService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupRepository = Container.get(GroupRepository);
  // No direct db or schema imports!
}
```

#### 2.1.6 CreateHoldingsWithDependenciesUseCase - Proper Delegation
Uses services for all operations:
```typescript
@Service()
export class CreateHoldingsWithDependenciesUseCase {
  private readonly institutionService = Container.get(InstitutionService);
  private readonly accountService = Container.get(AccountService);
  private readonly holdingService = Container.get(HoldingService);
  // Delegates to services, doesn't touch db directly
  
  async execute(input, user) {
    const institution = await this.institutionService.createInstitution(...);
    const account = await this.accountService.createAccount(...);
    const holdings = await this.holdingService.createManyHoldingsWithEvents(...);
  }
}
```

### 2.2 ❌ What's Bad

#### 2.2.1 **CRITICAL: Repository Pattern Completely Bypassed**

**This is the root cause of your "11 files to update" problem.**

9 out of 14 use cases directly import `db` and `schema`:
```typescript
// CreateHoldingUseCase.ts
import { db } from "../database/connection";
import * as schema from "../database/schema";

// Then directly queries and inserts:
const [account] = await tx
  .select()
  .from(schema.accounts)
  .where(and(
    eq(schema.accounts.id, input.accountId),
    eq(schema.accounts.userId, userId),
  ))
  .limit(1);

const [newHolding] = await tx
  .insert(schema.holdings)
  .values(holdingData)
  .returning();
```

**Why this is the core problem:**
When you want to add a side effect (like creating a portfolio event on every holding creation), you must:
1. ❌ Find all use-cases that create holdings
2. ❌ Find all services that create holdings  
3. ❌ Add event creation code to each one
4. ❌ Hope you didn't miss any

If all holding creation went through `HoldingRepository.create()`:
1. ✅ Add event creation to ONE place: `HoldingRepository.create()`
2. ✅ Done

#### 2.2.2 Duplicate Query Logic

Same validation queries written multiple times:
```typescript
// CreateHoldingUseCase.ts - lines 61-74
const [account] = await tx
  .select()
  .from(schema.accounts)
  .where(and(
    eq(schema.accounts.id, input.accountId),
    eq(schema.accounts.userId, userId),
  ))
  .limit(1);

// UpdateHoldingUseCase.ts - similar pattern
// DeleteHoldingUseCase.ts - similar pattern
// ImportBinanceAccountsUseCase.ts - similar pattern
```

**Should be:**
```typescript
const account = await this.accountRepository.findByIdAndUser(input.accountId, userId);
```

#### 2.2.3 No BaseService for Most Use Cases

Only 1 out of 14 use cases extends `BaseService`:
```typescript
// GetAssetAllocationUseCase - ✅ Extends BaseService
export class GetAssetAllocationUseCase extends BaseService {

// CreateHoldingUseCase - ❌ No BaseService
export class CreateHoldingUseCase {
  // No validateRequiredFields, handleError, withTransaction, logging utilities
}
```

Missing benefits:
- Standardized logging (`this.logger`)
- Error handling helpers (`this.handleError()`)
- Validation utilities (`this.validateRequiredFields()`)
- Transaction wrapper (`this.withTransaction()`)

#### 2.2.4 Inconsistent Event Creation Pattern

Some use cases create events, some don't:
```typescript
// CreateHoldingUseCase - Creates event inline (after transaction)
await this.userPortfolioEventService.createHoldingCreateEvent({...});

// DeleteHoldingUseCase - Creates event in separate method
await this.createDeleteEvent(result.deleted, userId, options.baseCurrencyId);

// UpdateHoldingsBatchUseCase - NO event creation at all!
// Just updates holdings, no events
```

#### 2.2.5 God Use Cases (Large Files)

| Use Case | Lines | Complexity |
|----------|-------|------------|
| ImportWalletAddressUseCase | 823 | Very High |
| SyncExchangeBalancesUseCase | 562 | High |
| SyncWalletBalancesUseCase | 551 | High |
| ImportBinanceAccountsUseCase | 430 | High |

These handle too much:
- External API calls
- Token mapping/creation
- Account creation
- Holding creation/update
- Error aggregation
- Metadata management

#### 2.2.6 Duplicate extractPriceMap (Again!)

Same method exists in:
1. `AccountService.ts`
2. `DashboardService.ts`
3. `GetAssetAllocationUseCase.ts` (line 73-84)

```typescript
// GetAssetAllocationUseCase.ts
private extractPriceMap(portfolioValue: PortfolioValueResult): Map<string, string> {
  const priceMap = new Map<string, string>();
  for (const portfolioHolding of portfolioValue.holdings) {
    // ... same code as services
  }
}
```

---

## 3. Dependency Flow Analysis

### 3.1 Current (Broken) Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      tRPC ROUTERS                                │
│                           │                                      │
├───────────────────────────┼──────────────────────────────────────┤
│                           ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    FEATURES LAYER                           ││
│  │          (implementations.ts - 1013 lines)                  ││
│  │                           │                                 ││
│  │    ┌──────────────────────┼──────────────────────┐         ││
│  │    ▼                      ▼                      ▼         ││
│  │ Use Cases            Services              Repositories    ││
│  │    │                      │                      │         ││
│  │    │  ┌───────────────────┼──────────────────────┤         ││
│  │    │  │                   │                      │         ││
│  │    ▼  ▼                   ▼                      ▼         ││
│  │  Direct DB!         Direct DB!              Direct DB      ││
│  │  (9/14 bypass)      (5/21 bypass)           (proper)       ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Ideal Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      tRPC ROUTERS                                │
│                           │                                      │
├───────────────────────────┼──────────────────────────────────────┤
│                           ▼                                      │
│                      USE CASES                                   │
│          (Complex orchestration only)                            │
│                           │                                      │
│                           ▼                                      │
│                       SERVICES                                   │
│            (Business logic, calculations)                        │
│                           │                                      │
│                           ▼                                      │
│                     REPOSITORIES                                 │
│        (ALL data access, events, validation)                     │
│                           │                                      │
│                           ▼                                      │
│                       DATABASE                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. SOLID Principles Assessment

| Principle | Score | Notes |
|-----------|-------|-------|
| **S**ingle Responsibility | 6/10 | Each use case has single purpose, but some are too large (800+ lines) |
| **O**pen/Closed | 4/10 | Adding new features (events) requires modifying existing use cases |
| **L**iskov Substitution | 5/10 | No interfaces, can't substitute implementations |
| **I**nterface Segregation | 3/10 | No interfaces at all; monolithic implementations |
| **D**ependency Inversion | 3/10 | **Major violation** - Use cases depend on concrete DB, not abstractions |

---

## 5. Specific Issues Catalog

### 5.1 High Priority Issues

| ID | Issue | File(s) | Impact |
|----|-------|---------|--------|
| UC-001 | 9/14 use cases bypass repositories | Multiple | Root cause of "11 files to update" |
| UC-002 | Large use cases (500-800+ lines) | Import*, Sync* | Hard to maintain, test, understand |
| UC-003 | No use case interfaces | All | Can't mock, tight coupling |
| UC-004 | Inconsistent event creation | Create/Update/Batch | Events missing in some paths |

### 5.2 Medium Priority Issues

| ID | Issue | File(s) | Impact |
|----|-------|---------|--------|
| UC-005 | Only 1/14 extends BaseService | 13 use cases | Missing logging/validation utilities |
| UC-006 | Duplicate query patterns | Multiple | DRY violation, maintenance burden |
| UC-007 | Duplicate extractPriceMap | GetAssetAllocationUseCase | Third copy of same code |

### 5.3 Low Priority Issues

| ID | Issue | File(s) | Impact |
|----|-------|---------|--------|
| UC-008 | Module-level loggers | All use cases | Not using BaseService pattern |
| UC-009 | Inconsistent error handling | Multiple | Some throw, some log and continue |

---

## 6. Root Cause Analysis: The "11 Files Problem"

### Why adding portfolio events required updating 11 files:

**Current State:**
```
Holding Creation Paths:
1. CreateHoldingUseCase.execute()      → Direct tx.insert(schema.holdings)
2. ImportBinanceAccountsUseCase        → Direct tx.insert(schema.holdings)  
3. ImportKrakenAccountsUseCase         → Direct tx.insert(schema.holdings)
4. ImportWalletAddressUseCase          → Direct tx.insert(schema.holdings)
5. SyncExchangeBalancesUseCase         → HoldingService → HoldingRepository
6. SyncWalletBalancesUseCase           → HoldingService → HoldingRepository
7. HoldingService.createHolding()      → HoldingRepository.create()
8. features/implementations.ts         → Uses various paths above
```

To add events, you had to:
- Modify `CreateHoldingUseCase` ✗
- Modify `ImportBinanceAccountsUseCase` ✗
- Modify `ImportKrakenAccountsUseCase` ✗
- Modify `ImportWalletAddressUseCase` ✗
- Modify `HoldingService` ✓ (added createHoldingWithEvent)
- Modify callers to use new service methods ✗

**Ideal State:**
```
ALL Holding Creation Paths:
1. CreateHoldingUseCase.execute()      → HoldingService.createHolding()
2. ImportBinanceAccountsUseCase        → HoldingService.createHolding()
3. ImportKrakenAccountsUseCase         → HoldingService.createHolding()
4. ImportWalletAddressUseCase          → HoldingService.createHolding()
5. SyncExchangeBalancesUseCase         → HoldingService.createHolding()
6. SyncWalletBalancesUseCase           → HoldingService.createHolding()
                                                    │
                                                    ▼
                                       HoldingRepository.create()
                                                    │
                                                    ▼
                                       Portfolio event created HERE
```

To add events:
- Modify `HoldingRepository.create()` - ONE place ✓

---

## 7. Recommendations

### 7.1 Immediate Actions (High Priority)

#### 7.1.1 Refactor Use Cases to Use Services/Repositories

**Before:**
```typescript
// CreateHoldingUseCase.ts
import { db } from "../database/connection";
import * as schema from "../database/schema";

const [newHolding] = await tx
  .insert(schema.holdings)
  .values(holdingData)
  .returning();
```

**After:**
```typescript
// CreateHoldingUseCase.ts
import { HoldingService } from "../services/HoldingService";

const newHolding = await this.holdingService.createHoldingWithEvent({
  accountId: input.accountId,
  tokenId: input.tokenId,
  balance: input.balance,
  userId,
  eventContext: { baseCurrencyId: user.baseCurrencyId, price: "0" }
}, tx);
```

#### 7.1.2 Create Use Case Interfaces

```typescript
// packages/core/src/use-cases/interfaces/ICreateHoldingUseCase.ts
export interface ICreateHoldingUseCase {
  execute(input: CreateHoldingInput, user: User): Promise<CreateHoldingResult>;
}

@Service()
export class CreateHoldingUseCase implements ICreateHoldingUseCase {
  // ...
}
```

#### 7.1.3 Extend BaseService for All Use Cases

```typescript
@Service()
export class CreateHoldingUseCase extends BaseService {
  constructor() {
    super('CreateHoldingUseCase');
  }
  
  async execute(input: CreateHoldingInput, user: User): Promise<CreateHoldingResult> {
    this.logger.debug({ input, userId: user.id }, 'Creating holding');
    this.validateRequiredFields(input, ['accountId', 'tokenId', 'balance']);
    // ...
  }
}
```

### 7.2 Short-Term Improvements (Medium Priority)

#### 7.2.1 Split Large Use Cases

`ImportWalletAddressUseCase` (823 lines) should become:
```typescript
// ChainDetectionService - Detect which chains a wallet exists on
// WalletAccountService - Create/update wallet accounts
// WalletHoldingsImporter - Import holdings for a wallet
// ImportWalletAddressUseCase - Orchestrate the above (now ~100 lines)
```

#### 7.2.2 Extract Shared Utilities

Create a shared module for repeated patterns:
```typescript
// packages/core/src/utils/portfolio-helpers.ts
export function extractPriceMap(portfolioValue: PortfolioValueResult): Map<string, string> {
  // Single implementation used by all services/use-cases
}
```

#### 7.2.3 Standardize Event Creation

All holding mutations should go through `HoldingService`:
```typescript
// Always use HoldingService for mutations (not direct DB)
await this.holdingService.createHoldingWithEvent(...);
await this.holdingService.updateHoldingBalanceWithEvent(...);
await this.holdingService.deleteHoldingWithEvent(...);
```

### 7.3 Long-Term Improvements (Low Priority)

#### 7.3.1 Command/Query Separation

Separate read and write use cases:
```typescript
// Commands (mutations)
CreateHoldingCommand.ts
DeleteHoldingCommand.ts
ImportWalletCommand.ts

// Queries (reads)
GetAssetAllocationQuery.ts
GetPortfolioValueQuery.ts
```

#### 7.3.2 Event Sourcing for Portfolio Events

Instead of creating events as a side effect:
```typescript
// Domain events drive all state changes
const event = new HoldingCreatedEvent(holdingData);
await this.eventStore.append(event);
await this.holdingProjection.apply(event); // Creates holding in DB
```

---

## 8. Use Case Layer Metrics

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Use cases with direct DB access | 9/14 (64%) | 0% | ❌ Critical |
| Average use case size | 334 lines | < 200 lines | ❌ Over |
| Max use case size | 823 lines | < 300 lines | ❌ Critical |
| Use cases extending BaseService | 1/14 (7%) | 100% | ❌ Missing |
| Use cases with interfaces | 0/14 (0%) | 100% | ❌ Missing |

---

## 9. Summary

### Strengths
1. Clear single responsibility per use case
2. Good transaction handling with `withTransaction` helper
3. Proper separation of external API calls from DB transactions
4. Some use cases (`GetAssetAllocationUseCase`, `CreateHoldingsWithDependenciesUseCase`) follow correct patterns

### Critical Weaknesses
1. **64% of use cases bypass repositories** - This is the root cause of your architectural pain
2. **Large use cases** (500-800+ lines) - Hard to maintain and test
3. **No interfaces** - Can't mock or substitute implementations
4. **Inconsistent event creation** - Some paths create events, some don't
5. **Only 7% extend BaseService** - Missing standardized utilities

### The Core Problem Visualized

```
WHAT YOU HAVE:

   UseCase1 ──┐
   UseCase2 ──┼──▶ Direct DB Access ──▶ 😢 Must update all when adding events
   UseCase3 ──┘

WHAT YOU NEED:

   UseCase1 ──┐                         ┌──▶ Events created
   UseCase2 ──┼──▶ Service ──▶ Repo ──┼──▶ Validation
   UseCase3 ──┘                         └──▶ 😊 One place to modify
```

---

**Document Status:** Complete  
**Analysis Complete:** All 4 steps finished

## Next Steps

Based on this 4-step analysis, the recommended action plan is:

1. **Phase 1 (Week 1-2):** Refactor use cases to use `HoldingService` instead of direct DB
2. **Phase 2 (Week 2-3):** Add missing repository methods, remove direct DB from services
3. **Phase 3 (Week 3-4):** Split large use cases, create interfaces
4. **Phase 4 (Ongoing):** Standardize BaseService usage, extract shared utilities
