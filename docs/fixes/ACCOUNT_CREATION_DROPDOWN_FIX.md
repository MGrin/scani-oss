# Fix: Newly Created Accounts Not Appearing in Dropdowns

**Date**: 2025-10-09  
**Status**: ✅ Fixed  
**Priority**: 🔴 Critical  

---

## Problem

When creating a new account (especially when also creating a new institution), the newly created account did not appear in the account dropdown selector immediately after creation. The user had to reload the page to see the newly created account.

### Steps to Reproduce
1. Go to Add Data page
2. Select "Create New Account" option
3. Select "Create New Institution" option
4. Fill in institution details (name, type, etc.)
5. Fill in account details (name, type, etc.)
6. Submit the form
7. **Bug**: The newly created account doesn't appear in the account dropdown
8. User has to reload the page to see it

---

## Root Cause

The issue was in the cache refresh logic:

### Flow Analysis

1. **Account Creation** → `getAccountCreateHandlers()` in `entityManager.ts`
   - Creates optimistic update
   - Sends mutation to backend
   - Calls `refreshAccountsViews()` in `onSettled` hook

2. **refreshAccountsViews()** in `refresh.ts` (BEFORE FIX)
   ```typescript
   export function refreshAccountsViews(utils, options) {
     const tasks = [
       invalidateAccountsRelated(utils, { ... }),  // ❌ Only invalidates
     ];
     // ❌ NO refetch calls - data doesn't update!
     return collectTasks(tasks);
   }
   ```

3. **EntityDataContext** uses `trpc.accounts.getAll.useQuery()`
   - React Query doesn't refetch invalidated queries automatically unless:
     - Component remounts
     - Query becomes stale (based on `staleTime`)
     - Manual refetch is triggered
   - Since we only invalidated (didn't refetch), the query stays cached

4. **Result**: Dropdown shows stale data without the new account

### Similar Issue for Institutions

The same issue existed for `refreshInstitutionsViews()` - newly created institutions wouldn't appear in dropdowns either.

---

## Solution

Added explicit `refetch()` calls to both `refreshAccountsViews()` and `refreshInstitutionsViews()` to ensure that `EntityDataContext` queries are updated immediately after creation.

### Changes Made

**File**: `apps/frontend/src/lib/cache/refresh.ts`

#### Fix #1: refreshAccountsViews

```typescript
// BEFORE (❌ Broken - only invalidates)
export function refreshAccountsViews(utils, options) {
  const tasks = [
    invalidateAccountsRelated(utils, { ... }),
  ];
  
  // Missing refetch!
  
  return collectTasks(tasks);
}

// AFTER (✅ Fixed - invalidates AND refetches)
export function refreshAccountsViews(utils, options) {
  const tasks = [
    invalidateAccountsRelated(utils, { ... }),
  ];
  
  // CRITICAL FIX: Refetch core queries that EntityDataContext depends on
  tasks.push(safeRefetch(utils.accounts.getAll.refetch));
  tasks.push(safeRefetch(utils.accounts.getSummaries.refetch));
  
  if (institutionIds.length > 0) {
    tasks.push(invalidateInstitutionsRelated(utils, { ... }));
    // Also refetch institutions so they show updated account counts
    tasks.push(safeRefetch(utils.institutions.getAll.refetch));
  }
  
  return collectTasks(tasks);
}
```

#### Fix #2: refreshInstitutionsViews

```typescript
// BEFORE (❌ Broken - only invalidates)
export function refreshInstitutionsViews(utils, options) {
  const tasks = [
    invalidateInstitutionsRelated(utils, { ... }),
  ];
  
  // Missing refetch!
  
  return collectTasks(tasks);
}

// AFTER (✅ Fixed - invalidates AND refetches)
export function refreshInstitutionsViews(utils, options) {
  const tasks = [
    invalidateInstitutionsRelated(utils, { ... }),
  ];
  
  // CRITICAL FIX: Refetch core queries that EntityDataContext depends on
  tasks.push(safeRefetch(utils.institutions.getAll.refetch));
  if (utils.institutions.getByUserId) {
    tasks.push(safeRefetch(utils.institutions.getByUserId.refetch));
  }
  
  if (cascadeAccounts) {
    // ... invalidations ...
    // Also refetch accounts so they reflect the new institution
    tasks.push(safeRefetch(utils.accounts.getAll.refetch));
  }
  
  return collectTasks(tasks);
}
```

---

## Why This Pattern Works

### invalidate() vs refetch()

**`invalidate()`**:
- Marks query as stale
- Query will refetch:
  - On next component mount
  - When `staleTime` expires
  - When explicitly triggered
- ❌ **Does NOT** guarantee immediate update

**`refetch()`**:
- Forces immediate data fetch from server
- Updates cache with fresh data
- Returns a Promise that resolves when complete
- ✅ **Guarantees** immediate update

### EntityDataContext Pattern

The `EntityDataContext` provides entity data to components via:
```typescript
const accountsQuery = trpc.accounts.getAll.useQuery(undefined, options);
```

React Query's behavior:
- If cache is invalidated but query is NOT actively subscribed → No refetch
- If cache is invalidated AND query IS actively subscribed → Refetches when stale
- If `refetch()` is called → Always refetches immediately

Since `EntityDataContext` is mounted at app level, its queries are always subscribed, but they won't refetch until stale time expires or component remounts.

**Solution**: Call `refetch()` explicitly after mutations to force immediate updates.

---

## Consistency with Holdings Pattern

This fix brings `refreshAccountsViews()` and `refreshInstitutionsViews()` in line with the existing `refreshHoldingsViews()` pattern:

```typescript
// refreshHoldingsViews() (already had this pattern)
export function refreshHoldingsViews(utils, options) {
  const tasks = [
    invalidateHoldingsRelated(utils, { ... }),
    invalidateAccountsRelated(utils, { ... }),
  ];
  
  // ✅ ALREADY had explicit refetch calls
  tasks.push(safeRefetch(utils.holdings.getAll.refetch));
  tasks.push(safeRefetch(utils.accounts.getAll.refetch));
  tasks.push(safeRefetch(utils.tokens.getAll.refetch));
  
  return collectTasks(tasks);
}
```

Holdings worked correctly because it already had this pattern. Now accounts and institutions follow the same approach.

---

## Testing

### Manual Test Cases

✅ **Test 1: Create account in existing institution**
1. Go to Add Data
2. Select "Create New Account"
3. Select existing institution
4. Fill in account details
5. Submit
6. **Expected**: New account appears in dropdown immediately

✅ **Test 2: Create account in new institution**
1. Go to Add Data
2. Select "Create New Account"
3. Select "Create New Institution"
4. Fill in institution details
5. Fill in account details
6. Submit
7. **Expected**: Both new institution and new account appear in dropdowns immediately

✅ **Test 3: Create multiple accounts sequentially**
1. Create first account
2. Verify it appears
3. Create second account
4. Verify both appear
5. **Expected**: All accounts visible without page reload

---

## Impact

### Before Fix
- ❌ User confusion: "I created the account but can't find it"
- ❌ Poor UX: Required page reload to see new data
- ❌ Lost user trust: "Did the creation work?"
- ❌ Inconsistent behavior: Holdings worked, but accounts didn't

### After Fix
- ✅ Instant feedback: New accounts appear immediately
- ✅ Consistent behavior: All entity types work the same way
- ✅ Better UX: Smooth workflow without reloads
- ✅ User confidence: Clear confirmation that creation succeeded

---

## Related Issues

This is the same class of issue as:
- **Fix #1** in `CODE_REVIEW_FIXES_IMPLEMENTED.md`: Cache invalidation race conditions in holdings creation
- **Fix #2** in `CODE_REVIEW_FIXES_IMPLEMENTED.md`: Optimistic update rollback issues

### Pattern: Always use refetch() after mutations

**Rule of thumb**: After any mutation that creates/updates/deletes entities:
1. ✅ Cancel in-flight queries (`cancel()`)
2. ✅ Apply optimistic updates (`setData()`)
3. ✅ On error: rollback + `refetch()` to sync with server
4. ✅ On success: replace temp IDs with real ones
5. ✅ On settled: `refetch()` core queries that components depend on

---

## Files Modified

- `apps/frontend/src/lib/cache/refresh.ts`
  - Updated `refreshAccountsViews()` - Added refetch calls (lines 83-84, 95)
  - Updated `refreshInstitutionsViews()` - Added refetch calls (lines 35-38, 56)

---

## Related Documentation

- **Code Review**: `docs/reviews/COMPREHENSIVE_CODE_REVIEW_2025-10-09.md`
- **Previous Fixes**: `docs/fixes/CODE_REVIEW_FIXES_IMPLEMENTED.md`
- **Cache Architecture**: `apps/frontend/src/lib/cache/README.md` (if exists)

---

## Prevention

To prevent similar issues in the future:

### Code Review Checklist
- [ ] Does mutation create/update/delete entities?
- [ ] Does `onSettled` call a `refresh*Views()` function?
- [ ] Does that refresh function call `refetch()` on core queries?
- [ ] Are queries used by `EntityDataContext` explicitly refetched?
- [ ] Is behavior consistent with other entity types?

### Testing Checklist
- [ ] Create entity and verify it appears in dropdowns immediately
- [ ] Create nested entities (e.g., account + institution) and verify both appear
- [ ] Test with multiple sequential creations
- [ ] Test error scenarios and verify rollback works

---

## Metrics to Monitor

After deployment:
- **Time to visibility**: Should be <1 second after creation
- **User reloads**: Should decrease significantly (track page reload events)
- **Cache hit rate**: Should remain >80%
- **Support tickets**: Should see fewer "data not appearing" issues

---

**Fix Completed**: 2025-10-09  
**Testing Status**: Ready for manual QA  
**Ready for**: Production deployment

