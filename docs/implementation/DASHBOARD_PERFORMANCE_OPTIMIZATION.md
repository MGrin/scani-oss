# Dashboard Performance Optimization

**Date**: October 15, 2025  
**Status**: ✅ Completed  
**Issue**: Dashboard cold load taking ~2.4 seconds with 20+ database queries

## Performance Issues Identified

From backend logs analysis:

- **Total Response Time**: ~2.4 seconds for batched tRPC request
- **Dashboard Overview**: ~1.6 seconds (dominant bottleneck)
- **Query Volume**: 20+ individual SELECT queries
- **N+1 Query Patterns**: Multiple separate queries for holdings, tokens, accounts, institutions, token types
- **Sequential Processing**: Queries executed sequentially rather than in parallel
- **Pricing Overhead**: 32 tokens requiring price fetches (~1 second)

## Implemented Optimizations

### 1. Database Indexes (✅ Completed)

Added composite indexes to improve query performance on frequently joined tables:

**Holdings Table** (`apps/backend/src/infrastructure/database/schema.ts`):

```typescript
// Composite indexes for dashboard queries
userAccountTokenIdx: index('idx_holdings_user_account_token')
  .on(table.userId, table.accountId, table.tokenId),
userTokenIdx: index('idx_holdings_user_token')
  .on(table.userId, table.tokenId),
```

**Accounts Table**:

```typescript
// Composite index for dashboard queries
userInstitutionIdx: index('idx_accounts_user_institution')
  .on(table.userId, table.institutionId),
```

**Tokens Table**:

```typescript
// Index for dashboard queries filtering by type
typeIdIdx: index('idx_tokens_type_id').on(table.typeId),
```

**Migration Generated**: `0009_fat_kulan_gath.sql` (awaiting user application)

**Expected Impact**: 20-30% reduction in query execution time

### 2. Optimized Repository Method (✅ Completed)

Created new method in `HoldingRepository` following Onion architecture principles:

**New Method**: `findByUserWithCompleteDetails()`

- **Location**: `apps/backend/src/infrastructure/repositories/HoldingRepository.ts`
- **Purpose**: Single optimized query replacing 5-7 separate queries
- **Returns**: Holdings with complete related data (token + type, account + institution)
- **Joins**:
  - `holdings` → `tokens` → `tokenTypes`
  - `holdings` → `accounts` → `institutions`

**Benefits**:

- Reduces ~15 queries to 1 query
- Eliminates N+1 query pattern
- Pre-fetches all needed data in single database round-trip

### 3. Parallelized Operations (✅ Completed)

Refactored `DashboardService.getDashboardOverview()` to parallelize independent operations:

**Before**:

```typescript
// Sequential execution
const portfolioValue = await this.portfolioService.getUserPortfolioValue(...);
const accounts = await this.accountRepository.findByUser(...);
const holdings = await this.holdingRepository.findByUser(...);
// ... then process data sequentially
```

**After**:

```typescript
// Parallel execution
const [portfolioValue, holdingsWithDetails] = await Promise.all([
  this.portfolioService.getUserPortfolioValue(userId, userBaseCurrencyId),
  this.holdingRepository.findByUserWithCompleteDetails(userId),
]);

// Parallel calculation
const [topHoldings, assetAllocation] = await Promise.all([
  this.calculateTopHoldings(holdingsWithDetails, portfolioValue),
  this.calculateAssetAllocation(holdingsWithDetails, portfolioValue),
]);
```

**Expected Impact**: 15-25% reduction in total response time

### 4. Eliminated Redundant Queries (✅ Completed)

**Removed**:

- Separate `accounts.findByUser()` call
- Separate `holdings.findByUser()` call
- Multiple `tokens.findByIds()` calls
- Multiple `tokenTypes.findByIds()` calls
- Multiple `institutions.findByIds()` calls

**Approach**: Extract account and institution data from the single optimized query result

## Architecture Compliance

All changes follow **Onion Architecture** principles:

- ✅ **No direct DB calls in services** - All queries through repositories
- ✅ **Repository layer encapsulation** - Business logic in service layer
- ✅ **Dependency injection** - Using TypeDI Container
- ✅ **Type safety** - Proper TypeScript types throughout

## Code Quality

- Added proper TypeScript types: `PortfolioValueResult`, `HoldingWithDetails`
- Removed unused repository dependencies
- Maintained existing error handling patterns
- Preserved logging for debugging

## Expected Performance Improvements

Based on similar optimization patterns:

- **Query Count**: Reduced from ~20 queries to ~2-3 queries (85-90% reduction)
- **Total Response Time**: Expected reduction from 2.4s to <1s (50-60% improvement)
- **Dashboard Overview**: Expected reduction from 1.6s to <500ms (70% improvement)

## Migration Steps for User

1. Apply database migration:

   ```bash
   cd apps/backend
   bun run db:migrate
   ```

2. Restart backend server:

   ```bash
   # From root
   bun dev
   ```

3. Test dashboard load performance:
   - Open browser DevTools Network tab
   - Navigate to dashboard
   - Check `dashboard.getOverview` request time

## Testing Recommendations

1. **Functional Testing**:

   - Verify dashboard displays correctly
   - Check all counts (institutions, accounts, holdings)
   - Verify top holdings list
   - Confirm asset allocation chart

2. **Performance Testing**:

   - Cold load (first request after restart)
   - Warm load (subsequent requests)
   - Compare with baseline logs provided

3. **Edge Cases**:
   - Empty holdings
   - Single holding
   - Large portfolios (100+ holdings)

## Files Modified

1. **Schema** (with indexes):

   - `apps/backend/src/infrastructure/database/schema.ts`
   - `apps/backend/src/infrastructure/database/migrations/0009_fat_kulan_gath.sql` (generated)

2. **Repository** (new optimized method):

   - `apps/backend/src/infrastructure/repositories/HoldingRepository.ts`

3. **Service** (parallelized + optimized):
   - `apps/backend/src/application/services/DashboardService.ts`

## Next Steps

1. User applies database migration
2. Monitor performance improvements in logs
3. Consider similar optimizations for:
   - Account detail page
   - Holdings list page
   - Transaction history queries

## References

- Original logs analysis showed 20+ queries taking 2.4s total
- Optimization targets: Points 1, 2, and 3 from initial analysis
- Onion architecture maintained throughout implementation
