# Holdings Data Fetching Optimization

**Date**: October 15, 2025  
**Status**: ✅ Completed

## Problem Statement

The account details page and holdings page both use `GetHoldingsWithDetailsUseCase`, but with an inefficiency:

- **Account Details Page**: Calls `accounts.getHoldings(accountId)` which executed the use case and then filtered by account ID in the router
- **Use Case**: Always computed the entire user's portfolio via `portfolioValuationService.getUserPortfolioValue()`
- **Result**: When viewing a single account's holdings, we unnecessarily computed prices and valuations for ALL accounts

## Solution

Made both the use case and the service **account-aware** by adding an optional `accountId` parameter throughout the stack.

### Changes Made

#### 1. PortfolioValuationService (`apps/backend/src/application/services/PortfolioValuationService.ts`)

**Updated Method Signature:**

```typescript
async getUserPortfolioValue(
  userId: string,
  userBaseCurrencyId?: string,
  accountId?: string  // NEW: Optional account filter
): Promise<{...}>
```

**Key Changes:**

- Added `accountId` parameter to filter holdings query
- Uses conditional where clause: `and(eq(holdings.userId, userId), eq(holdings.accountId, accountId))` when accountId is provided
- Updated logging to indicate when filtering by account
- Only fetches prices for tokens in the specific account (not the entire portfolio)

**Performance Impact:**

- Before: Queries ALL user holdings + prices for ALL tokens across ALL accounts
- After: Queries ONLY holdings for specific account + prices for ONLY those tokens

#### 2. GetHoldingsWithDetailsUseCase (`apps/backend/src/application/use-cases/GetHoldingsWithDetailsUseCase.ts`)

**Updated Method Signature:**

```typescript
async execute(
  userId: string,
  baseCurrencyId?: string,
  accountId?: string  // NEW: Optional account filter
): Promise<HoldingWithDetails[]>
```

**Key Changes:**

- Added `accountId` parameter
- Filters holdings from repository if accountId is provided
- Passes `accountId` to `portfolioValuationService.getUserPortfolioValue()`
- Updated logging to indicate account-specific requests

**Performance Impact:**

- Before: Fetched all holdings, computed all prices, then filtered in router
- After: Fetches only relevant holdings, computes only relevant prices

#### 3. Accounts Router (`apps/backend/src/presentation/routers/accounts.ts`)

**Before:**

```typescript
// Get all holdings with details, then filter by account
const allHoldings = await getHoldingsWithDetailsUseCase.execute(
  dbUser.id,
  dbUser.baseCurrencyId || undefined
);
return allHoldings.filter((holding) => holding.account.id === input.id);
```

**After:**

```typescript
// Pass accountId directly to use case for optimized query
return await getHoldingsWithDetailsUseCase.execute(
  dbUser.id,
  dbUser.baseCurrencyId || undefined,
  input.id // Pass account ID for filtering at the service layer
);
```

**Performance Impact:**

- Eliminated post-query filtering in the router
- Filtering now happens at the database/service layer

## Performance Benefits

### Account Details Page (`accounts.getHoldings`)

- **Before**: Computed portfolio value for entire user (all accounts, all tokens)
- **After**: Computes portfolio value ONLY for the specific account
- **Savings**: Proportional to (total_accounts - 1) × (tokens_per_account)

### Holdings Page (`holdings.getWithDetails`)

- **Before**: Computed portfolio value for entire user
- **After**: Still computes entire portfolio (accountId not passed)
- **Impact**: No change - optimization is opt-in via accountId parameter

### Example Scenario

User with 5 accounts, 10 tokens per account = 50 total holdings:

- **Before (Account Details)**: Fetches 50 holdings + prices for 50 token types
- **After (Account Details)**: Fetches 10 holdings + prices for 10 token types
- **Reduction**: 80% fewer database queries and API calls

## Backwards Compatibility

✅ **Fully backwards compatible**

- `accountId` parameter is optional
- When not provided, behavior is identical to previous implementation
- Holdings page continues to work without changes
- Account details page benefits from optimization automatically

## Architecture Adherence

✅ **Follows onion architecture**

- Presentation layer (router) delegates to use case
- Use case coordinates repositories and services
- Service layer handles database queries with business logic
- No direct database access in use cases or routers

## Testing

- ✅ TypeScript compilation passes
- ✅ Backend build succeeds
- ✅ No breaking changes to existing API contracts
- 🔄 Manual testing recommended:
  - View account details page (should load faster for multi-account users)
  - View holdings page (should work identically to before)
  - Verify price information displays correctly in both views

## Future Enhancements

1. **Repository-level filtering**: Consider adding `findByUserAndAccount()` method to `HoldingRepository` to push filtering even deeper
2. **Caching**: Add caching layer for portfolio valuations (especially useful for dashboard views)
3. **Pagination**: Add pagination to holdings queries for users with hundreds of holdings
4. **Metrics**: Add performance metrics/logging to measure actual performance gains

## Related Files

- `/apps/backend/src/application/services/PortfolioValuationService.ts`
- `/apps/backend/src/application/use-cases/GetHoldingsWithDetailsUseCase.ts`
- `/apps/backend/src/presentation/routers/accounts.ts`
- `/apps/backend/src/presentation/routers/holdings.ts`
