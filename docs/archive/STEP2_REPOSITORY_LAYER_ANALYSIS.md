# Step 2: Repository Layer Analysis

**Date:** Analysis performed on existing codebase  
**Scope:** `packages/core/src/repositories/` - All repository classes  
**Overall Score:** 6.5/10

---

## Executive Summary

The repository layer provides a solid foundation with a well-designed `BaseRepository` abstract class and proper use of TypeDI for dependency injection. However, there are **significant architectural violations** where services and use-cases bypass the repository pattern entirely, directly importing database connections and schema. This defeats the purpose of having a repository abstraction and creates tight coupling between business logic and database implementation.

---

## 1. Inventory

### 1.1 Repository Files

| Repository                                  | Lines | Extends Base   | Key Methods                                                                                                             |
| ------------------------------------------- | ----- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `BaseRepository.ts`                         | 347   | N/A (abstract) | `findById`, `findByIds`, `findAll`, `findWithPagination`, `create`, `createMany`, `update`, `delete`, `exists`, `count` |
| `HoldingRepository.ts`                      | 411   | ✅ Yes         | `findByUser`, `findByUserWithFullDetails`, `findByAccount`, `markAsHidden`, `updateBalance`, `deleteById`               |
| `AccountRepository.ts`                      | 152   | ✅ Yes         | `findByUser`, `findWalletAccounts`, `updateMetadata`, `updateAccount`                                                   |
| `TokenRepository.ts`                        | 110   | ✅ Yes         | `findBySymbol`, `findBySymbolAndType`, `findByType`, `createMany`                                                       |
| `TokenPriceRepository.ts`                   | 257   | ✅ Yes         | `findLatestPrice`, `findLatestPricesForTokens`, `bulkUpsert`, `findPriceAtTimestamp`, `findClosestPrice`                |
| `GroupRepository.ts`                        | 423   | ✅ Yes         | `findByUser`, `findByUserWithCounts`, `assignHoldingGroups`, `assignAccountGroups`, `bulkAssignAccountGroups`           |
| `UserPortfolioEventRepository.ts`           | 247   | ✅ Yes         | `findByUserIdPaginated`, `findByUserIdInDateRange`, `createMany`, `findUserHoldingsForToken`                            |
| `InstitutionRepository.ts`                  | 46    | ✅ Yes         | `findByUserId`                                                                                                          |
| `UserRepository.ts`                         | 11    | ✅ Yes         | (only inherited methods)                                                                                                |
| `UserWalletRepository.ts`                   | 110   | ✅ Yes         | `findByUser`, `findByUserAndAddress`, `findByAddress`, `findByInstitution`                                              |
| `UserIntegrationCredentialsRepository.ts`   | 146   | ✅ Yes         | `findByUser`, `findByUserAndInstitution`, `findByInstitution`, `findByType`                                             |
| `InstitutionBlockchainMappingRepository.ts` | 75    | ✅ Yes         | `findByInstitutionId`, `findByChainId`, `findAllActive`                                                                 |
| `ApiKeyRepository.ts`                       | 135   | ✅ Yes         | `findByUserId`, `findActiveByPrefix`, `updateLastUsed`, `revoke`                                                        |
| `EnumRepositories.ts`                       | 96    | ✅ Yes         | 3 repos: `InstitutionTypeRepository`, `AccountTypeRepository`, `TokenTypeRepository` - each has `findByCode`            |

**Total:** 14 concrete repositories + 1 abstract base

### 1.2 Domain Entities

Domain entities are **type aliases** from schema, not rich domain models:

```typescript
// packages/core/src/domain/entities/index.ts
export type { Account, NewAccount, Holding, NewHolding, ... } from '../../database/schema';
```

**Issue:** No separation between persistence models and domain models (Anemic Domain Model anti-pattern).

---

## 2. Architectural Patterns Analysis

### 2.1 ✅ What's Good

#### 2.1.1 BaseRepository Pattern

The `BaseRepository` provides excellent DRY implementation:

- Generic type parameters `<TEntity, TNewEntity>`
- Transaction support via `getDb(transaction?: DatabaseTransaction)`
- Comprehensive CRUD operations with proper error handling and logging
- Pagination support with `findWithPagination`
- Dynamic filter building with `buildWhereConditions`

```typescript
@Service()
export abstract class BaseRepository<TEntity, TNewEntity = Partial<TEntity>> {
  protected abstract readonly table: PgTable<TableConfig>;
  protected abstract readonly tableName: string;

  protected getDb(transaction?: DatabaseTransaction) {
    const db = getDbConnection();
    return transaction || db;
  }
}
```

#### 2.1.2 TypeDI Integration

All repositories use `@Service()` decorator for proper DI:

```typescript
@Service()
export class HoldingRepository extends BaseRepository<Holding, NewHolding> {}
```

#### 2.1.3 Logging

Consistent structured logging in all operations:

```typescript
this.logger.error({ userId, error }, "Failed to find groups by user");
```

#### 2.1.4 Transaction Support

All methods accept optional `transaction` parameter:

```typescript
async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Group[]>
```

### 2.2 ❌ What's Bad

#### 2.2.1 **CRITICAL: Repository Pattern Bypassed** (SOLID Violation)

**Problem:** 7 use-cases and 5 services directly import `db` and `schema`, bypassing repositories entirely.

**Use-Cases bypassing repositories:**
| File | Direct DB Imports |
|------|-------------------|
| `ImportBinanceAccountsUseCase.ts` | `import { db }` + `import * as schema` |
| `ImportKrakenAccountsUseCase.ts` | `import { db }` + `import * as schema` |
| `SyncWalletBalancesUseCase.ts` | `import { db }` + `import * as schema` |
| `SyncExchangeBalancesUseCase.ts` | `import { db }` + `import * as schema` |
| `CreateHoldingUseCase.ts` | `import { db }` + `import * as schema` |
| `UpdateHoldingUseCase.ts` | `import { db }` + `import * as schema` |
| `DeleteHoldingUseCase.ts` | `import { db }` + `import * as schema` |

**Services bypassing repositories:**
| File | Direct DB Imports |
|------|-------------------|
| `AgenticUserService.ts` | `import { db }` + `import * as schema` |
| `UserContextService.ts` | `import { db }` + `import * as schema` |
| `PortfolioValuationService.ts` | `import { db }` + `import * as schema` |
| `PortfolioHistoryService.ts` | `import { db }` |
| `PricingService.ts` | `import { db }` |

**Why this is bad:**

1. **Violates Dependency Inversion Principle (DIP)** - High-level modules depend on low-level modules
2. **Defeats Repository Abstraction** - Can't switch persistence layer without touching business logic
3. **Testing Nightmare** - Can't mock repositories since they're not used
4. **Inconsistent Data Access** - Some code goes through repos, some doesn't
5. **Duplicated Queries** - Same queries might be written in multiple places

**Example of bypass in use-case:**

```typescript
// ImportBinanceAccountsUseCase.ts - Line 242
const [institution] = await tx
  .insert(schema.accounts) // Direct schema access!
  .values(accountData)
  .returning();
```

#### 2.2.2 Raw SQL in Repository (Leaky Abstraction)

`UserPortfolioEventRepository.ts` uses raw SQL string:

```typescript
const results = await database.execute<HoldingRow>(sql`
  SELECT h.user_id, h.id as holding_id, ...
  FROM holdings h
  JOIN accounts a ON a.id = h.account_id
  ...
`);
```

**Issues:**

- Column names use snake_case (`user_id`) while TypeScript uses camelCase
- No type safety from Drizzle ORM
- Potential SQL injection if not careful
- Harder to maintain and refactor

#### 2.2.3 Inconsistent Return Types

Some methods return `T | null`, others return `T | undefined`:

```typescript
// Returns null
async findById(id: string): Promise<TEntity | null>

// Returns undefined
async findByUserAndAddress(userId: string, walletAddress: string): Promise<UserWallet | undefined>
```

#### 2.2.4 In-Memory Filtering

`UserWalletRepository.findByInstitution` filters in memory:

```typescript
// Query all wallets then filter
const results = await database.select().from(schema.userWallets)...
return results.filter((wallet) => {
  // In-memory filter for JSONB array
});
```

**Why bad:** Performance issue - fetches all data, then filters. Should use PostgreSQL's `@>` operator.

#### 2.2.5 Anemic Domain Model

Entities are just type aliases from schema:

```typescript
export type { Holding, NewHolding, ... } from '../../database/schema';
```

**No:**

- Domain logic/methods on entities
- Value objects
- Domain events
- Invariant validation

#### 2.2.6 Missing Repositories

Some tables don't have dedicated repositories:

- `transactions` table
- `holdingGroups` / `accountGroups` (managed by GroupRepository)

---

## 3. SOLID Principles Assessment

| Principle                 | Score | Notes                                                                                        |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| **S**ingle Responsibility | 7/10  | Repositories focused on data access, but some do too much (GroupRepository manages 3 tables) |
| **O**pen/Closed           | 6/10  | BaseRepository is extensible, but concrete repos often need modification for new queries     |
| **L**iskov Substitution   | 8/10  | Repositories can be substituted (though rarely done in practice)                             |
| **I**nterface Segregation | 5/10  | No repository interfaces - clients depend on concrete implementations                        |
| **D**ependency Inversion  | 4/10  | **Major violation** - Services/use-cases bypass repositories, depend directly on DB          |

---

## 4. Onion Architecture Assessment

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PRESENTATION LAYER                               │
│  (apps/backend/src/presentation/routers/*.ts)                           │
│                              │                                          │
│                              ▼                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                         APPLICATION LAYER                                │
│  (packages/core/src/use-cases/*.ts)                                     │
│                              │                                          │
│                    ┌─────────┼─────────┐                                │
│                    ▼         ▼         ▼                                │
│              Use Repos    Direct DB   Both (BAD!)                       │
│                              │                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                         DOMAIN LAYER                                     │
│  (packages/core/src/domain/entities/ - ANEMIC!)                         │
│                              │                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                      INFRASTRUCTURE LAYER                                │
│  (packages/core/src/repositories/*.ts)                                  │
│  (packages/core/src/database/*)                                         │
└─────────────────────────────────────────────────────────────────────────┘

VIOLATIONS:
- Application layer bypasses Domain/Repository layer
- Domain layer is anemic (no business logic)
- Direct DB imports in 12+ non-repository files
```

---

## 5. Specific Issues Catalog

### 5.1 High Priority Issues

| ID    | Issue                           | File(s)                           | Impact                                           |
| ----- | ------------------------------- | --------------------------------- | ------------------------------------------------ |
| R-001 | Use-cases bypass repositories   | 7 use-case files                  | Architecture violation, testing difficulty       |
| R-002 | Services bypass repositories    | 5 service files                   | Architecture violation, inconsistent data access |
| R-003 | Raw SQL with snake_case columns | `UserPortfolioEventRepository.ts` | Type safety loss, mapping issues                 |
| R-004 | No repository interfaces        | All repositories                  | Can't mock, tight coupling                       |

### 5.2 Medium Priority Issues

| ID    | Issue                               | File(s)                   | Impact                             |
| ----- | ----------------------------------- | ------------------------- | ---------------------------------- |
| R-005 | In-memory JSONB filtering           | `UserWalletRepository.ts` | Performance                        |
| R-006 | Inconsistent null/undefined returns | Multiple repos            | API inconsistency                  |
| R-007 | GroupRepository manages 3 tables    | `GroupRepository.ts`      | SRP violation                      |
| R-008 | Anemic domain model                 | `domain/entities/`        | No encapsulation of business rules |

### 5.3 Low Priority Issues

| ID    | Issue                                    | File(s)             | Impact                      |
| ----- | ---------------------------------------- | ------------------- | --------------------------- |
| R-009 | Missing dedicated transaction repository | N/A                 | Incomplete abstraction      |
| R-010 | UserRepository has no custom methods     | `UserRepository.ts` | Minimal value-add over base |

---

## 6. Recommendations

### 6.1 Immediate Actions (High Priority)

#### 6.1.1 Create Repository Interfaces

```typescript
// packages/core/src/repositories/interfaces/IHoldingRepository.ts
export interface IHoldingRepository {
  findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Holding[]>;
  findByUserWithFullDetails(userId: string, ...): Promise<HoldingWithDetails[]>;
  // ... all public methods
}

// Then:
@Service()
export class HoldingRepository extends BaseRepository<Holding, NewHolding>
  implements IHoldingRepository { }
```

#### 6.1.2 Refactor Use-Cases to Use Repositories

**Before (bad):**

```typescript
// CreateHoldingUseCase.ts
import { db } from "../database/connection";
import * as schema from "../database/schema";

const [holding] = await db.insert(schema.holdings).values(data).returning();
```

**After (good):**

```typescript
// CreateHoldingUseCase.ts
import { HoldingRepository } from "../repositories";

constructor(private holdingRepository: HoldingRepository) {}

const holding = await this.holdingRepository.create(data);
```

#### 6.1.3 Add Missing Repository Methods

Instead of bypassing repositories, add methods that are missing:

```typescript
// HoldingRepository.ts - add these
async createWithEvent(data: NewHolding, transaction?: DatabaseTransaction): Promise<Holding>;
async updateBalanceWithEvent(id: string, balance: Decimal, transaction?: DatabaseTransaction): Promise<Holding>;
```

### 6.2 Short-Term Improvements (Medium Priority)

#### 6.2.1 Fix JSONB Filtering

```typescript
// UserWalletRepository.ts - use PostgreSQL @> operator
async findByInstitution(institutionId: string): Promise<UserWallet[]> {
  const database = this.getDb();
  return await database
    .select()
    .from(schema.userWallets)
    .where(
      sql`${schema.userWallets.institutionIds} @> ${JSON.stringify([institutionId])}`
    );
}
```

#### 6.2.2 Standardize Return Types

Choose either `null` or `undefined` for "not found" and apply consistently.

**Recommendation:** Use `null` (more explicit about absence)

#### 6.2.3 Split GroupRepository

```typescript
// Separate concerns:
- GroupRepository (groups table only)
- HoldingGroupRepository (holding_groups junction table)
- AccountGroupRepository (account_groups junction table)
```

### 6.3 Long-Term Improvements (Low Priority)

#### 6.3.1 Rich Domain Model

Transform anemic entities into rich domain objects:

```typescript
// packages/core/src/domain/Holding.ts
export class Holding {
  private constructor(
    public readonly id: string,
    public readonly accountId: string,
    private _balance: Decimal,
    // ...
  ) {}

  static create(data: NewHolding): Holding {
    // Validation logic
    return new Holding(...);
  }

  updateBalance(newBalance: Decimal): BalanceUpdateEvent {
    if (newBalance.isNegative()) {
      throw new InvalidBalanceError();
    }
    const oldBalance = this._balance;
    this._balance = newBalance;
    return new BalanceUpdateEvent(this.id, oldBalance, newBalance);
  }
}
```

#### 6.3.2 Unit of Work Pattern

For complex operations spanning multiple repositories:

```typescript
export class UnitOfWork {
  constructor(
    readonly holdings: HoldingRepository,
    readonly accounts: AccountRepository,
    readonly events: UserPortfolioEventRepository,
  ) {}

  async executeInTransaction<T>(
    work: (uow: UnitOfWork) => Promise<T>,
  ): Promise<T> {
    return await db.transaction(async (tx) => {
      return work(this.withTransaction(tx));
    });
  }
}
```

---

## 7. Comparison with Best Practices

| Aspect               | Current State           | Best Practice                 | Gap                           |
| -------------------- | ----------------------- | ----------------------------- | ----------------------------- |
| Repository Pattern   | Partially implemented   | Fully encapsulate data access | Major - bypassed in 12+ files |
| Dependency Injection | TypeDI used             | Interface-based DI            | Need interfaces               |
| Domain Model         | Anemic (type aliases)   | Rich domain objects           | Significant                   |
| Transaction Handling | Per-method transactions | Unit of Work                  | Could improve                 |
| Query Abstraction    | Drizzle ORM             | Specification Pattern         | Nice to have                  |

---

## 8. Summary

### Strengths

1. Well-designed `BaseRepository` with comprehensive CRUD operations
2. TypeDI properly integrated
3. Transaction support throughout
4. Good logging practices

### Critical Weaknesses

1. **12+ files bypass repository pattern** - This is the most significant issue
2. **No repository interfaces** - Can't mock or substitute implementations
3. **Anemic domain model** - No business logic encapsulation

### Next Steps

1. **Audit all `db` and `schema` imports** outside repositories
2. **Create missing repository methods** instead of bypassing
3. **Define repository interfaces** for better testability
4. **Consider rich domain model** for complex business logic

---

**Document Status:** Complete  
**Next Analysis:** Step 3 - Service Layer Analysis
