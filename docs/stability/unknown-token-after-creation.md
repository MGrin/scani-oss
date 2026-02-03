# Fix: "Unknown Token" Display After Holding Creation

## Problem
After creating a new holding with a new external token, the Holdings page displays "Unknown Token" instead of the token's name and symbol. This persisted until the user manually refreshed the page.

## Root Cause
The issue was caused by a **cache mismatch** between what queries were being refetched and what queries the Holdings page actually uses:

1. **Holdings page uses**: `trpc.tokens.getByUserId.useQuery()` to fetch tokens (line 56 in `Holdings.tsx`)
2. **AddData page was refetching**: Only `utils.tokens.getAll.refetch()` after holding creation

This meant that after creating a new token and holding:
- The `tokens.getAll` cache was updated ✅
- The `tokens.getByUserId` cache remained stale ❌
- The Holdings page rendered with stale token data, showing "Unknown Token"

## Solution
The fix involved two changes to `apps/frontend/src/pages/AddData.tsx`:

### 1. Immediate Token Cache Refresh After External Token Creation
After creating an external token via `createTokenFromExternal`, we now immediately refresh both token caches:

```typescript
tokenId = newToken.id;
console.log('External token created successfully:', tokenId);

// CRITICAL FIX: Refresh token cache immediately after creation
// This ensures the token is available in cache before creating the holding
await Promise.all([
  utils.tokens.getAll.refetch(),
  utils.tokens.getByUserId.refetch(),
]);
```

This ensures the token exists in both caches before we proceed to create the holding.

### 2. Token Cache Refresh After Holding Creation
After creating the holding, we now refetch both token queries along with the other entity queries:

```typescript
// CRITICAL FIX: Use refetch() instead of invalidate() to wait for completion
// This prevents race conditions where UI expects data before it's fetched
await Promise.all([
  utils.holdings.getAll.refetch(),
  utils.accounts.getAll.refetch(),
  utils.institutions.getAll.refetch(),
  utils.tokens.getAll.refetch(),
  utils.tokens.getByUserId.refetch(), // Also refetch tokens by user ID for Holdings page
]);
```

This ensures that when the user navigates to the Holdings page, both token caches are fresh and synchronized.

## Key Insight
This bug highlights the importance of understanding **which queries components actually use** versus which queries are being invalidated/refetched. The pattern is:

1. Identify all queries used by the destination component
2. Ensure all those queries are refreshed after mutations
3. Use explicit `refetch()` calls rather than just `invalidate()` when you need synchronous cache updates before navigation

## Testing
To verify the fix:
1. Navigate to Add Data page
2. Create a new holding with a new external token (e.g., USDC)
3. After creation, verify the Holdings page immediately shows the token name and symbol
4. No page refresh should be required

## Related Files
- `apps/frontend/src/pages/AddData.tsx` - Fixed token cache refresh logic
- `apps/frontend/src/pages/Holdings.tsx` - Component that displays holdings with tokens
- `apps/frontend/src/lib/cache/refresh.ts` - Cache refresh utilities

## Backend Verification
Backend logs confirm token creation is successful:
```
✅ Procedure completed successfully: tokens.createFromExternal
External token created successfully with valid ID
```

The issue was purely on the frontend cache synchronization side.
