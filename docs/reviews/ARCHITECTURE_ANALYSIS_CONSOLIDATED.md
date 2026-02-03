# Scani Finance - Comprehensive Architecture Analysis

**Date:** February 2026  
**Scope:** Full codebase architecture review (Database → Repositories → Services → Use Cases)

---

## Executive Summary

This document consolidates the analysis of all four architectural layers in the Scani Finance SaaS application. The analysis reveals a **fundamental architectural violation**: the repository pattern is bypassed by 64% of use cases and 24% of services, creating the root cause of maintenance pain where adding cross-cutting concerns (like portfolio events) requires modifying 11+ files instead of one.

### Overall Architecture Health

| Layer | Score | Critical Issues |
|-------|-------|-----------------|
| **Database** | 8.3/10 | Minor index and naming inconsistencies |
| **Repository** | 6.5/10 | Bypassed by higher layers, no interfaces |
| **Service** | 6.0/10 | PricingService God class (2059 lines), DB bypass |
| **Use Cases** | 5.5/10 | 64% bypass repositories directly |

**Weighted Average: 6.6/10**

---

## 1. Architecture Overview

### Current (Broken) Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PRESENTATION LAYER                               │
│  (apps/backend/src/presentation/routers/*.ts)                           │
│                              │                                          │
├──────────────────────────────┼──────────────────────────────────────────┤
│                              ▼                                          │
│                      FEATURES LAYER                                      │
│             (implementations.ts - 1013 lines)                           │
│                              │                                          │
│              ┌───────────────┼───────────────┐                          │
│              ▼               ▼               ▼                          │
├──────────────────────────────────────────────────────────────────────────┤
│                      USE CASES LAYER                                     │
│                         14 use cases                                    │
│                              │                                          │
│                    ┌─────────┼─────────┐                                │
│                    ▼         ▼         ▼                                │
│              Via Service  Direct DB   Both                              │
│               (29%)      (64%)       (7%)                               │
│                              │                                          │
├──────────────────────────────┼──────────────────────────────────────────┤
│                      SERVICE LAYER                                       │
│                        21 services                                      │
│                              │                                          │
│                    ┌─────────┼─────────┐                                │
│                    ▼         ▼                                          │
│              Via Repos    Direct DB                                     │
│               (76%)       (24%)                                         │
│                              │                                          │
├──────────────────────────────┼──────────────────────────────────────────┤
│                     REPOSITORY LAYER                                     │
│                       14 repositories                                   │
│                              │                                          │
│                              ▼                                          │
│                         DATABASE                                         │
│                     (18 tables, PostgreSQL)                             │
└─────────────────────────────────────────────────────────────────────────┘

PROBLEM: Multiple arrows bypass layers, reaching DB directly
```

### Ideal Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PRESENTATION LAYER                               │
│                          (tRPC Routers)                                 │
│                              │                                          │
│                              ▼                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                         USE CASES LAYER                                  │
│               (Complex orchestration of business operations)            │
│                              │                                          │
│                              ▼                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                         SERVICE LAYER                                    │
│             (Business logic, calculations, external APIs)               │
│                              │                                          │
│                              ▼                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                        REPOSITORY LAYER                                  │
│          (ALL data access, events, validation, caching)                 │
│                              │                                          │
│                              ▼                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                           DATABASE                                       │
└─────────────────────────────────────────────────────────────────────────┘

SOLUTION: Single path through all layers, no bypasses
```

---

## 2. Database Layer Summary (Score: 8.3/10)

### Strengths
- **UUID Primary Keys**: Consistent use across all 18 tables
- **Excellent Index Coverage**: 7 indexes on holdings, 6 on user_portfolio_events
- **Proper Cascade Rules**: User deletion cascades to all owned data
- **Financial Precision**: Monetary values stored as `text` for Decimal.js precision
- **Dynamic Enums**: Types stored in database tables (not TypeScript enums)
- **Intentional Denormalization**: `userId` on holdings for query performance

### Entity Inventory (18 tables)

| Category | Tables |
|----------|--------|
| **Core Entities** | users, institutions, accounts, holdings, tokens, token_prices |
| **Portfolio** | user_portfolio_events |
| **User Data** | user_wallets, user_integration_credentials, api_keys |
| **Grouping** | groups, holding_groups, account_groups |
| **Mappings** | institution_blockchain_mappings |
| **Enums** | institution_types, account_types, token_types |

### Issues

| ID | Issue | Impact | Priority |
|----|-------|--------|----------|
| DB-001 | Missing index on `api_keys.key_hash` | Authentication performance | High |
| DB-002 | `lastUpdated` vs `updatedAt` inconsistency on holdings | Minor confusion | Low |

---

## 3. Repository Layer Summary (Score: 6.5/10)

### Strengths
- **Solid BaseRepository**: Generic CRUD operations with pagination, transactions, logging
- **TypeDI Integration**: All repositories use `@Service()` decorator
- **Transaction Support**: All methods accept optional `transaction` parameter
- **Consistent Logging**: Structured logging in all operations

### Repository Inventory (14 repositories)

| Repository | Lines | Key Methods |
|------------|-------|-------------|
| BaseRepository | 347 | findById, findAll, findWithPagination, create, update, delete |
| HoldingRepository | 411 | findByUser, findByUserWithFullDetails, updateBalance |
| GroupRepository | 423 | findByUser, assignHoldingGroups, assignAccountGroups |
| TokenPriceRepository | 257 | findLatestPrice, bulkUpsert, findClosestPrice |
| UserPortfolioEventRepository | 247 | findByUserIdPaginated, createMany |
| Others | ~600 | Various specialized operations |

### Critical Issues

| ID | Issue | Files Affected | Impact |
|----|-------|----------------|--------|
| R-001 | Use cases bypass repositories | 9 use-case files | Architecture violation |
| R-002 | Services bypass repositories | 5 service files | Inconsistent data access |
| R-003 | No repository interfaces | All repositories | Cannot mock, tight coupling |
| R-004 | Raw SQL with snake_case columns | UserPortfolioEventRepository | Type safety loss |
| R-005 | In-memory JSONB filtering | UserWalletRepository | Performance |
| R-006 | Anemic domain model | domain/entities/ | No encapsulated business rules |
| R-007 | GroupRepository manages 3 tables | GroupRepository | SRP violation |

### Files Bypassing Repositories

**Use Cases (9 files):**
- CreateHoldingUseCase.ts
- DeleteHoldingUseCase.ts
- UpdateHoldingUseCase.ts
- UpdateHoldingsBatchUseCase.ts
- ImportBinanceAccountsUseCase.ts
- ImportKrakenAccountsUseCase.ts
- ImportWalletAddressUseCase.ts
- SyncExchangeBalancesUseCase.ts
- SyncWalletBalancesUseCase.ts

**Services (5 files):**
- PricingService.ts
- PortfolioValuationService.ts
- PortfolioHistoryService.ts
- UserContextService.ts
- AgenticUserService.ts

---

## 4. Service Layer Summary (Score: 6.0/10)

### Strengths
- **BaseService Pattern**: Logging, transactions, validation, error handling
- **Event-Driven HoldingService**: Proper `createHoldingWithEvent` pattern
- **Pure Domain Logic**: ScamTokenDetectionService has no DB access
- **Encryption**: IntegrationCredentialsService properly encrypts credentials

### Service Inventory (21 services)

| Service | Lines | Extends BaseService | Direct DB |
|---------|-------|---------------------|-----------|
| PricingService | **2059** | ❌ No | ✅ Yes |
| HoldingService | 893 | ✅ Yes | ❌ No |
| TokenService | 836 | ✅ Yes | ❌ No |
| PortfolioHistoryService | 655 | ❌ No | ✅ Yes |
| TokenValidationService | 611 | ❌ No | ❌ No |
| AccountService | 317 | ✅ Yes | ❌ No |
| PortfolioValuationService | 265 | ❌ No | ✅ Yes |
| Others | ~1500 | Mixed | Mixed |

### Critical Issues

| ID | Issue | Details | Impact |
|----|-------|---------|--------|
| S-001 | PricingService God class | 2059 lines, handles rate limiting, caching, providers, conversion, fetching | Unmaintainable |
| S-002 | 5 services bypass repositories | Direct `db` + `schema` imports | Architecture violation |
| S-003 | DashboardService → Use-Case dependency | Imports GetAssetAllocationUseCase | Inverted layer direction |
| S-004 | No service interfaces | All services are concrete | Cannot mock, tight coupling |
| S-005 | Duplicate extractPriceMap | AccountService + DashboardService | DRY violation |
| S-006 | Inconsistent BaseService usage | 4 services don't extend | Missing utilities |
| S-007 | Global rate limiters at module level | PricingService | Hidden global state |
| S-008 | Raw SQL in services | PortfolioHistoryService | Type safety loss |

---

## 5. Use Cases Layer Summary (Score: 5.5/10)

### Strengths
- **Single Responsibility**: Each use case has clear, focused purpose
- **Transaction Handling**: Good use of `withTransaction` helper
- **API Separation**: External API calls properly separated from DB transactions
- **Some Proper Patterns**: GetAssetAllocationUseCase, CreateHoldingsWithDependenciesUseCase

### Use Case Inventory (14 use cases)

| Use Case | Lines | Direct DB | BaseService |
|----------|-------|-----------|-------------|
| ImportWalletAddressUseCase | **823** | ✅ Yes | ❌ No |
| SyncExchangeBalancesUseCase | 562 | ✅ Yes | ❌ No |
| SyncWalletBalancesUseCase | 551 | ✅ Yes | ❌ No |
| ImportBinanceAccountsUseCase | 430 | ✅ Yes | ❌ No |
| GetAssetAllocationUseCase | 370 | ❌ No | ✅ Yes |
| ParseScreenshotUseCase | 350 | ❌ No | ❌ No |
| CreateHoldingUseCase | 341 | ✅ Yes | ❌ No |
| DeleteHoldingUseCase | 222 | ✅ Yes | ❌ No |
| CreateHoldingsWithDependenciesUseCase | 215 | ❌ No | ❌ No |
| UpdateHoldingPriceUseCase | 163 | ❌ No | ❌ No |
| UpdateHoldingUseCase | 141 | ✅ Yes | ❌ No |
| UpdateHoldingsBatchUseCase | 112 | ✅ Yes | ❌ No |
| ImportKrakenAccountsUseCase | ~400 | ✅ Yes | ❌ No |
| UpdateTokenPricesUseCase | ~100 | ✅ Yes | ❌ No |

### Critical Issues

| ID | Issue | Details | Impact |
|----|-------|---------|--------|
| UC-001 | 64% bypass repositories | 9/14 use cases import `db` + `schema` | **Root cause of "11 files" problem** |
| UC-002 | Large use cases | 4 files > 400 lines, max 823 | Hard to maintain, test |
| UC-003 | No use case interfaces | 0% have interfaces | Cannot mock, tight coupling |
| UC-004 | Inconsistent event creation | Some paths create events, some don't | Data inconsistency |
| UC-005 | Only 7% extend BaseService | 1/14 use cases | Missing utilities |
| UC-006 | Duplicate query patterns | Account validation repeated | DRY violation |
| UC-007 | Third copy of extractPriceMap | GetAssetAllocationUseCase | Code duplication |

---

## 6. Root Cause Analysis: The "11 Files Problem"

When portfolio events were added, **11 files needed modification** because holding creation happens in multiple places:

```
CURRENT HOLDING CREATION PATHS:

1. CreateHoldingUseCase.execute()        → Direct tx.insert(schema.holdings)
2. ImportBinanceAccountsUseCase          → Direct tx.insert(schema.holdings)
3. ImportKrakenAccountsUseCase           → Direct tx.insert(schema.holdings)
4. ImportWalletAddressUseCase            → Direct tx.insert(schema.holdings)
5. SyncExchangeBalancesUseCase           → HoldingService → Repository
6. SyncWalletBalancesUseCase             → HoldingService → Repository
7. HoldingService.createHolding()        → HoldingRepository.create()
8. UpdateHoldingsBatchUseCase            → Direct (no events!)
9. features/implementations.ts           → Various paths above

To add events: Must modify paths 1-4, 8 + callers = 11+ files
```

**If all holding creation went through `HoldingRepository.create()`:**

```
ALL PATHS:
UseCase1 ──┐
UseCase2 ──┼──▶ HoldingService ──▶ HoldingRepository.create()
UseCase3 ──┤                              │
Service1 ──┤                              ▼
Service2 ──┘                       Events created HERE

To add events: Modify 1 file
```

---

## 7. SOLID Principles Violations Summary

| Layer | S | O | L | I | D | Avg |
|-------|---|---|---|---|---|-----|
| Database | 9 | 8 | 8 | 8 | 8 | 8.2 |
| Repository | 7 | 6 | 8 | 5 | **4** | 6.0 |
| Service | **4** | 6 | 7 | **4** | 5 | 5.2 |
| Use Cases | 6 | **4** | 5 | **3** | **3** | 4.2 |

**Critical Violations:**
- **Single Responsibility (S)**: PricingService God class (2059 lines)
- **Open/Closed (O)**: Adding events requires modifying all use cases
- **Interface Segregation (I)**: No interfaces at any layer
- **Dependency Inversion (D)**: Direct DB imports bypass abstractions

---

## 8. Complete Issue Catalog

### High Priority (Must Fix)

| ID | Issue | Layer | Impact |
|----|-------|-------|--------|
| UC-001 | 64% of use cases bypass repositories | Use Cases | Root cause of maintenance pain |
| S-001 | PricingService God class (2059 lines) | Service | Unmaintainable code |
| R-001 | Repository pattern ignored | Repository | Architecture violation |
| S-002 | 5 services bypass repositories | Service | Inconsistent data access |
| UC-004 | Inconsistent event creation | Use Cases | Data inconsistency |
| S-003 | Service depends on use-case | Service | Inverted layer dependency |

### Medium Priority (Should Fix)

| ID | Issue | Layer | Impact |
|----|-------|-------|--------|
| R-003 | No repository interfaces | Repository | Cannot mock |
| S-004 | No service interfaces | Service | Cannot mock |
| UC-003 | No use case interfaces | Use Cases | Cannot mock |
| UC-002 | Large use cases (500-823 lines) | Use Cases | Hard to maintain |
| S-005 | Duplicate extractPriceMap | Service | DRY violation |
| UC-007 | Third copy of extractPriceMap | Use Cases | DRY violation |
| S-006 | Inconsistent BaseService usage | Service | Missing utilities |
| UC-005 | 93% don't extend BaseService | Use Cases | Missing utilities |
| R-004 | Raw SQL in repository | Repository | Type safety loss |
| S-008 | Raw SQL in services | Service | Type safety loss |
| R-005 | In-memory JSONB filtering | Repository | Performance |
| DB-001 | Missing api_keys.key_hash index | Database | Auth performance |

### Low Priority (Nice to Fix)

| ID | Issue | Layer | Impact |
|----|-------|-------|--------|
| R-006 | Anemic domain model | Repository | No encapsulation |
| R-007 | GroupRepository manages 3 tables | Repository | SRP violation |
| S-007 | Global rate limiters | Service | Hidden state |
| DB-002 | lastUpdated vs updatedAt naming | Database | Minor confusion |
| S-009 | Inconsistent method naming | Service | Readability |
| UC-008 | Module-level loggers | Use Cases | Not using BaseService |

---

## 9. Layer Metrics Summary

| Metric | Database | Repository | Service | Use Cases | Target |
|--------|----------|------------|---------|-----------|--------|
| **Score** | 8.3/10 | 6.5/10 | 6.0/10 | 5.5/10 | 8.0/10 |
| **Files** | 1 schema | 14 repos | 21 services | 14 use cases | — |
| **Avg Lines** | N/A | 170 | 391 | 334 | < 200 |
| **Max Lines** | N/A | 423 | 2059 | 823 | < 300 |
| **With Interfaces** | N/A | 0% | 0% | 0% | 100% |
| **Extends Base** | N/A | 100% | 71% | 7% | 100% |
| **Direct DB Access** | N/A | 100% (correct) | 24% (bad) | 64% (bad) | 0% |

---

## 10. Conclusion

The Scani Finance codebase has a **solid foundation** with proper database design, a well-implemented `BaseRepository`, and good patterns in `HoldingService`. However, **the repository abstraction is not enforced**, leading to:

1. **64% of use cases** directly accessing the database
2. **24% of services** bypassing repositories
3. **No interfaces** at any layer
4. **A 2059-line God class** (PricingService)
5. **Duplicate code** across layers

The solution requires **enforcing the repository pattern** as the single point of data access, splitting the PricingService, creating interfaces at all layers, and standardizing on BaseService/BaseRepository patterns.

---

**Next Document:** [REFACTORING_IMPLEMENTATION_PLAN.md](./REFACTORING_IMPLEMENTATION_PLAN.md) - Detailed step-by-step plan to reach ideal architecture state.
