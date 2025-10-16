# Dashboard Duplicate Key Warning Fix

## Issue

React console warning:

```
Warning: Encountered two children with the same key, `USD`. Keys should be unique so that components maintain their identity across updates.
```

## Root Cause

The Dashboard component was using `holding.symbol` as the React key for top holdings:

```tsx
{
  overview.topHoldings.map((holding) => (
    <div key={holding.symbol}>
      {" "}
      // ❌ Not unique if user has multiple holdings of same token ...
    </div>
  ));
}
```

**Problem**: If a user has multiple holdings of the same token (e.g., USD in different accounts), they all share the same `symbol` value, causing React to see duplicate keys.

For example:

- USD in Bank Account 1
- USD in Bank Account 2
- USD in Wallet

All three would have `key="USD"`, causing the warning.

## Solution

### Backend Changes

**File**: `apps/backend/src/application/services/DashboardService.ts`

1. **Added unique `id` field** to each top holding using index:

```typescript
const topHoldings = topHoldingsData.map((h, index) => {
  const tokenDetails = tokenDetailsMap.get(h.tokenSymbol);
  return {
    id: `${h.tokenSymbol}-${index}`, // ✅ Unique ID for React keys
    symbol: h.tokenSymbol,
    name: tokenDetails?.name || h.tokenSymbol,
    balance: h.balance,
    value: h.value || "0",
    currentPrice: h.currentPrice || "0",
  };
});
```

2. **Updated interface** to include `id` field:

```typescript
export interface DashboardOverview {
  // ...
  topHoldings: Array<{
    id: string; // ✅ Added
    symbol: string;
    name: string;
    balance: string;
    value: string;
    currentPrice: string;
  }>;
  // ...
}
```

### Frontend Changes

**File**: `apps/frontendV2/src/pages/Dashboard.tsx`

Changed the key from `holding.symbol` to `holding.id`:

```tsx
{
  overview.topHoldings.map((holding) => (
    <div key={holding.id}>
      {" "}
      // ✅ Now unique
      <div>
        <div className="font-medium">{holding.symbol}</div>
        <div className="text-sm text-muted-foreground">{holding.name}</div>
      </div>
      <div className="text-right">
        <div className="font-medium">
          {formatCurrency(holding.value, currency)}
        </div>
      </div>
    </div>
  ));
}
```

## Why This Works

- **Backend**: Each top holding gets a unique ID in the format `{symbol}-{index}`
  - First USD holding: `USD-0`
  - Second USD holding: `USD-1`
  - BTC holding: `BTC-0`
- **Frontend**: React uses this unique ID as the key, eliminating duplicate key warnings

- **User Experience**: No change - users still see the token symbol, name, and value as before

## Alternative Solutions Considered

1. **Use holding ID from database**: Would require changing PortfolioValuationService to include holdingId
   - ❌ More complex, requires changes in multiple layers
2. **Aggregate holdings by symbol**: Combine multiple holdings of same token
   - ❌ Loses granularity, user can't see individual account holdings
3. **Use array index as key**: `key={index}`

   - ❌ Anti-pattern in React, can cause issues with list updates

4. **Use combination of symbol + index** (chosen solution):
   - ✅ Simple, unique, stable across renders
   - ✅ No database schema changes needed
   - ✅ Minimal code changes

## Testing

1. ✅ Backend compiles without errors
2. ✅ Frontend compiles without errors
3. ✅ Both servers start successfully
4. ⏳ Manual testing needed: Verify no console warnings in browser

## Impact

- **Breaking Changes**: None - response structure is extended, not changed
- **Performance**: No impact - index iteration is O(1)
- **Type Safety**: Full TypeScript support maintained
- **User Experience**: No visible changes

## Files Modified

- `apps/backend/src/application/services/DashboardService.ts`

  - Added `id` field to topHoldings mapping
  - Updated DashboardOverview interface

- `apps/frontendV2/src/pages/Dashboard.tsx`
  - Changed key from `holding.symbol` to `holding.id`

## Prevention

To prevent similar issues in the future:

1. **Always use unique identifiers for React keys**

   - Prefer database IDs when available
   - Use composite keys (id + index) when needed
   - Avoid using non-unique fields as keys

2. **Test with duplicate data**

   - Create test scenarios with multiple holdings of same token
   - Check browser console for React warnings

3. **Code review checklist**
   - Verify all `.map()` calls use unique keys
   - Check that keys are stable across renders
   - Ensure keys are not array indices (unless list is static)

## Related Issues

This fix is part of the larger dashboard refactoring to follow onion architecture. See:

- `docs/implementation/DASHBOARD_ONION_ARCHITECTURE_FIX.md`
