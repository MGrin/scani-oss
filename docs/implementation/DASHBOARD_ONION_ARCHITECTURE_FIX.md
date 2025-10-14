# Dashboard Onion Architecture Implementation

## Overview

Fixed architecture violation in the dashboard implementation by properly following the onion/clean architecture pattern. Removed direct database access from the router layer and implemented a proper service layer.

## Problem

The original dashboard router (`apps/backend/src/presentation/routers/dashboard.ts`) violated the onion architecture by:

1. **Direct Database Access**: Router directly used Drizzle ORM to query the database
2. **SQL Error**: Query attempted `where  = $1` with missing column name for institutions
3. **Schema Misunderstanding**: Tried to query institutions by `userId`, but institutions are global entities
4. **Business Logic in Router**: Complex calculations for asset allocation and aggregations in the router layer

## Solution

### 1. Created DashboardService (Service Layer)

**File**: `apps/backend/src/application/services/DashboardService.ts`

**Architecture Pattern**:

```
Router → Service → Repository → Database
```

**Key Methods**:

- `getDashboardOverview(userId, userBaseCurrencyId?)`: Aggregates all dashboard data

  - Portfolio value calculation (via PortfolioValuationService)
  - Entity counts (institutions, accounts, holdings)
  - Top 5 holdings by value
  - Asset allocation grouped by token type

- `getRecentActivity(userId, limit)`: Fetches recent transactions with enriched data
  - Optimized with batch loading to avoid N+1 queries
  - Enriches transactions with token symbols and transaction type names

**Dependencies**:

- `PortfolioValuationService`: For portfolio calculations
- `AccountRepository`: For user accounts
- `HoldingRepository`: For user holdings
- `TokenRepository`: For token details
- `TokenTypeRepository`: For token type information
- `TransactionRepository`: For transaction history
- `TransactionTypeRepository`: For transaction type details

### 2. Enhanced TokenTypeRepository

**File**: `apps/backend/src/infrastructure/repositories/EnumRepositories.ts`

**Added Method**: `findByIds(ids: string[]): Promise<TokenType[]>`

Allows batch fetching of token types to avoid N+1 queries in asset allocation calculation.

**Interface Updated**: `apps/backend/src/domain/interfaces/repositories/index.ts`

### 3. Refactored Dashboard Router

**File**: `apps/backend/src/presentation/routers/dashboard.ts`

**Before**: 202 lines with complex SQL queries and business logic
**After**: 27 lines - thin controller layer

**Changes**:

- Removed all direct database imports (`db`, `schema`, `eq`, `desc`, `sql`)
- Removed `Decimal.js` calculations (moved to service)
- Removed `PortfolioValuationService` direct usage (service handles it)
- Router now only:
  1. Extracts `userId` from context
  2. Gets `DashboardService` from DI container
  3. Delegates to service methods
  4. Returns results

### 4. Institutions Count Fix

**Problem**: Institutions are global entities (no `userId` field)

**Solution**: Calculate distinct institutions from user's accounts:

```typescript
const accounts = await this.accountRepository.findByUserId(userId);
const distinctInstitutionIds = new Set(
  accounts.map((acc) => acc.institutionId)
);
const institutionsCount = distinctInstitutionIds.size;
```

This properly counts how many unique institutions the user has accounts with.

## Architecture Benefits

### Separation of Concerns

- **Router**: HTTP concerns (auth, validation, response formatting)
- **Service**: Business logic (calculations, aggregations, orchestration)
- **Repository**: Data access (queries, persistence)
- **Database**: Storage

### Testability

- Service can be unit tested without HTTP layer
- Repositories can be mocked in service tests
- Business logic isolated and testable

### Reusability

- `DashboardService` can be used by:
  - HTTP API (current)
  - GraphQL resolvers (future)
  - Background jobs
  - CLI tools
  - Mobile API

### Maintainability

- Clear boundaries between layers
- Single responsibility for each layer
- Easy to modify without affecting other layers

## Performance Optimizations

### Batch Loading

- Top holdings: Single query for all token details
- Asset allocation: Batch fetch token types by IDs
- Recent activity: Batch fetch holdings, tokens, and transaction types

### Avoiding N+1 Queries

```typescript
// Before (N+1):
transactions.forEach(async (tx) => {
  const token = await tokenRepo.findById(tx.tokenId);
  const type = await typeRepo.findById(tx.typeId);
});

// After (Batch):
const tokenIds = [...new Set(transactions.map((tx) => tx.tokenId))];
const tokens = await Promise.all(tokenIds.map((id) => tokenRepo.findById(id)));
const tokenMap = new Map(tokens.map((t) => [t.id, t]));
```

### Parallel Queries

```typescript
const [accounts, holdings] = await Promise.all([
  this.accountRepository.findByUserId(userId),
  this.holdingRepository.findByUserId(userId),
]);
```

## Code Quality Improvements

### Type Safety

- All methods properly typed with TypeScript
- No `any` types used
- Explicit return types for all public methods

### Error Handling

- Logger integration at service level
- Debug logs for performance monitoring
- Error context preservation

### Documentation

- JSDoc comments for all public methods
- Clear parameter descriptions
- Return type documentation

## Migration Impact

### Breaking Changes

None - API contract remains the same.

### Frontend Impact

None - tRPC routes unchanged, response structure identical.

### Database Impact

None - No schema changes required.

## Testing Recommendations

### Unit Tests for DashboardService

```typescript
describe("DashboardService", () => {
  it("should calculate dashboard overview", async () => {
    // Mock repositories
    // Test getDashboardOverview
  });

  it("should handle empty holdings", async () => {
    // Test with no data
  });

  it("should batch load efficiently", async () => {
    // Verify no N+1 queries
  });
});
```

### Integration Tests for Dashboard Router

```typescript
describe("dashboardRouter", () => {
  it("should return overview for authenticated user", async () => {
    // Test getOverview endpoint
  });

  it("should return recent activity", async () => {
    // Test getRecentActivity endpoint
  });
});
```

## Files Changed

### Created

- `apps/backend/src/application/services/DashboardService.ts` (224 lines)

### Modified

- `apps/backend/src/presentation/routers/dashboard.ts` (202 → 27 lines, **86% reduction**)
- `apps/backend/src/infrastructure/repositories/EnumRepositories.ts` (Added `findByIds` method)
- `apps/backend/src/domain/interfaces/repositories/index.ts` (Updated `ITokenTypeRepository` interface)

## Next Steps

1. ✅ Create DashboardService following onion architecture
2. ✅ Add `TokenTypeRepository.findByIds` method
3. ✅ Refactor dashboard router to use service
4. ✅ Verify backend builds successfully
5. ⏳ Test dashboard with real data in development
6. ⏳ Apply same pattern to other routes (Holdings, Accounts, etc.)
7. ⏳ Add unit tests for DashboardService
8. ⏳ Add integration tests for dashboard router

## Conclusion

The dashboard now properly follows onion architecture with clear separation between:

- **Presentation Layer** (Router): Thin HTTP controllers
- **Application Layer** (Service): Business logic and orchestration
- **Domain Layer** (Entities/Interfaces): Core types and contracts
- **Infrastructure Layer** (Repositories): Data access

This implementation serves as a template for refactoring other routes in the application.
