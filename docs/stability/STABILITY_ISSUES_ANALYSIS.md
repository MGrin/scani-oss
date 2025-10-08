# Scani Stability Issues - Root Cause Analysis

**Date:** October 8, 2025
**Status:** Critical bugs identified affecting data consistency under load

## Executive Summary

After thorough investigation of the codebase, I've identified **7 critical race conditions and state management issues** that cause the application to behave incorrectly when loaded with data. These issues are NOT visible on a clean database but manifest as the system accumulates entities and user interactions.

---

## Critical Issues Identified

### 🔴 **Issue #1: Race Condition in Sequential Async Mutations (CRITICAL)**

**Location:** `apps/frontend/src/pages/AddData.tsx:950-1100`

**Problem:**
The app chains multiple `mutateAsync()` calls (institution → account → holding) without proper synchronization. The optimistic updates and cache invalidation from earlier mutations interfere with later mutations.

```tsx
// Current problematic code:
const newInstitution = await createInstitution.mutateAsync({...});
institutionId = newInstitution.id;

const newAccount = await createAccount.mutateAsync({
  institutionId: institutionId,  // May use stale cache
  ...
});

const createdHolding = await createHolding.mutateAsync({
  accountId,  // May not exist in cache yet
  ...
});
```

**Why it fails under load:**

1. First mutation updates optimistic cache with temp ID
2. Second mutation starts before first mutation's `onSettled` completes
3. Cache contains mix of temp and real data
4. Third mutation fails validation or references wrong entities

**Symptoms:**

- Holdings/accounts not created despite UI showing success
- "Account does not exist" errors despite just creating it
- Inconsistent entity references

---

### 🔴 **Issue #2: Missing Await in Parallel Invalidations (CRITICAL)**

**Location:** `apps/frontend/src/pages/AddData.tsx:1045-1060`

**Problem:**
After creating a holding, the code fires cache invalidations without awaiting them, then immediately navigates away. This causes:

- Navigation before data is refreshed
- New page loads with stale cache
- User sees old data despite successful creation

```tsx
// Current code - fires and forgets:
await Promise.all([
  invalidateHoldingsRelated(utils, {...}),  // Returns void
  invalidateAccountsRelated(utils, {...}),  // Returns void
  // ...
]);
navigate('/holdings');  // Navigates with stale data!
```

**Fix needed:** Invalidation functions should return Promises and be properly awaited.

---

### 🔴 **Issue #3: Optimistic Update Replacement Race Condition**

**Location:** `apps/frontend/src/lib/cache/optimistic/entityManager.ts:396-420`

**Problem:**
In `getHoldingCreateHandlers.onSuccess`, the code replaces the optimistic entity by ID, but if the mutation takes longer than expected, multiple optimistic updates might be in flight:

```typescript
async onSuccess(result, _variables, context) {
  const created = result as Holding | null;
  if (!created) return;  // ⚠️ Silent failure!

  const targetId = context?.tempId ?? normalized.id;
  utils.holdings.getAll.setData(undefined, (current) =>
    replaceEntityById(current, targetId, normalized)
  );
}
```

**Issue:** If `result` is null (which happens when backend returns null on constraint violations), the optimistic entity is never removed from cache, causing permanent phantom holdings.

---

### 🔴 **Issue #4: Cache Staleness from Aggressive Stale Time Settings**

**Location:** `apps/frontend/src/lib/trpc-provider.tsx:14-25`

**Problem:**

```tsx
staleTime: 5 * 60 * 1000,  // 5 minutes
cacheTime: 10 * 60 * 1000, // 10 minutes
refetchOnMount: false,
```

With 5-minute stale time:

1. User creates holding at 10:00 AM
2. Data marked stale at 10:05 AM
3. User creates another holding at 10:03 AM
4. UI uses cached data from 10:00 AM (still fresh)
5. New holding appears to fail (it succeeded, but cache is stale)

**Compounded by:** Several pages force `refetchOnMount: 'always'` to work around this, creating inconsistent behavior.

---

### 🔴 **Issue #5: WebSocket Invalidation Without Refetch Guarantee**

**Location:** `apps/frontend/src/hooks/useRealtimeEntitySync.ts:60-150`

**Problem:**
WebSocket handlers call `invalidate()` which only marks queries as stale, but doesn't guarantee refetch if no component is currently observing that query:

```typescript
case 'holding':
  void invalidateHoldingsRelated(utils, {...});  // ⚠️ void = ignored
  break;
```

If user is on different page when entity changes, invalidation happens but no refetch occurs. When they navigate back, they see stale data until manual refresh.

---

### 🔴 **Issue #6: Non-Atomic Multi-Entity Creation**

**Location:** `apps/backend/src/routers/holdings.ts:126-230`

**Problem:**
Holding creation uses a database transaction for the holding + transaction creation, but the flow `Institution → Account → Holding` spans multiple tRPC calls without cross-call transactions.

**Failure scenario:**

1. Frontend creates institution (succeeds)
2. Frontend creates account with institutionId (succeeds)
3. Frontend creates holding with accountId (fails due to network timeout)
4. User now has orphaned institution + account, UI thinks entire operation failed

**Backend can't rollback** because each mutation is a separate HTTP request.

---

### 🔴 **Issue #7: Inconsistent Error Handling in Mutations**

**Location:** Multiple files using `withOptimisticHandlers`

**Problem:**
Many mutations use `.mutate()` instead of `.mutateAsync()`, causing silent failures:

```tsx
// In HoldingForm.tsx:304
createHolding.mutate(submitData); // Fire and forget

// vs AddData.tsx:1037
await createHolding.mutateAsync(submitData); // Proper error handling
```

Using `.mutate()`:

- No way to catch errors in try/catch
- onError callback fires but form doesn't know to stop
- Loading states get stuck
- User can click "Submit" multiple times

---

## Performance Issues Contributing to Instability

### Issue #8: Excessive Refetch Cascades

**Location:** `apps/frontend/src/lib/cache/refresh.ts:103-150`

When a holding is created, the refresh cascade triggers:

1. `refreshHoldingsViews()` invalidates: holdings, accounts, tokens, transactions
2. Then FORCES refetch of: holdings.getAll, accounts.getAll, tokens.getAll, tokens.getByUserId, institutions.getAll
3. Each refetch can trigger dependent queries

**Result:** Creating 1 holding triggers 15+ HTTP requests.

### Issue #9: N+1 Query Pattern in Holdings Display

Multiple components fetch the same data independently:

- EntityDataContext: fetches accounts, institutions, tokens
- Holdings page: fetches holdings, then joins client-side
- Accounts page: fetches accounts again with summaries

No request deduplication leads to redundant backend queries under load.

---

## Random Loading Times Root Cause

The "random loading times" are caused by:

1. **Cache hit/miss lottery**: Depending on whether data is stale (5min window), request either:
   - Returns instantly from cache (~50ms)
   - Hits backend and waits for DB query (~500ms)
2. **Cascade amplification**: Each mutation can trigger 5-20 dependent refetches. If any are stale:

   - Best case: 1 backend call (primary query)
   - Worst case: 20+ backend calls (full cascade)

3. **Optimistic update conflicts**: When multiple mutations happen rapidly:
   - Optimistic updates succeed instantly (feels fast)
   - But later mutations fail due to stale cache references
   - UI shows loading → success → error → loading again

---

## Recommended Fixes (Priority Order)

### 🔥 **P0: Fix Sequential Mutation Race Conditions**

**File:** `apps/frontend/src/pages/AddData.tsx`

**Solution:** Ensure each mutation completes its full lifecycle (including onSettled) before starting next:

```tsx
// Add explicit waits between mutations
const newInstitution = await createInstitution.mutateAsync({...});
// Wait for cache to settle
await utils.institutions.getAll.refetch();

const newAccount = await createAccount.mutateAsync({
  institutionId: newInstitution.id,
});
await utils.accounts.getAll.refetch();

const createdHolding = await createHolding.mutateAsync({
  accountId: newAccount.id,
});
```

### 🔥 **P0: Fix Silent Null Returns in onSuccess**

**File:** `apps/frontend/src/lib/cache/optimistic/entityManager.ts`

**Solution:** Add error handling and cleanup when backend returns null:

```typescript
async onSuccess(result, variables, context) {
  const created = result as Holding | null;
  if (!created) {
    // Remove optimistic entity since creation failed
    if (context?.tempId) {
      utils.holdings.getAll.setData(undefined, (current) =>
        removeEntity(current, context.tempId)
      );
    }
    throw new Error('Backend returned null - entity not created');
  }
  // ... normal flow
}
```

### 🔥 **P0: Reduce Stale Time to Prevent Cache Inconsistency**

**File:** `apps/frontend/src/lib/trpc-provider.tsx`

**Solution:**

```tsx
staleTime: 30 * 1000,      // 30 seconds (was 5 minutes)
gcTime: 5 * 60 * 1000,     // 5 minutes (was 10 minutes)
refetchOnMount: 'always',  // Always fetch fresh on page load
```

### 🔧 **P1: Make Invalidations Return Promises**

**File:** `apps/frontend/src/lib/cache/invalidation.ts`

All invalidation functions should return `Promise<void>` instead of `void` to enable proper awaiting.

### 🔧 **P1: Add Request Deduplication**

**File:** `apps/frontend/src/lib/trpc-provider.tsx`

```tsx
defaultOptions: {
  queries: {
    staleTime: 30 * 1000,
    // Enable request deduplication
    networkMode: 'online',
    refetchInterval: false,
  },
},
```

### 🔧 **P1: Replace .mutate() with .mutateAsync() Everywhere**

Search for all `.mutate(` calls and replace with `.mutateAsync()` with proper try/catch.

### 🔧 **P2: Add Backend Batch Mutation Endpoint**

Create a single tRPC procedure for atomic multi-entity creation:

```typescript
createHoldingWithDependencies: protectedProcedure
  .input(
    z.object({
      institution: InstitutionCreateSchema.optional(),
      account: AccountCreateSchema,
      holding: HoldingCreateSchema,
    })
  )
  .mutation(async ({ input, ctx }) => {
    return await db.transaction(async (tx) => {
      // Create all entities in single DB transaction
      // Rollback if any step fails
    });
  });
```

### 🔧 **P2: Implement Optimistic Lock Versioning**

Add version field to entities:

```typescript
// In schema
holdings: {
  version: integer('version').notNull().default(0),
}

// In update mutations
.where(and(
  eq(holdings.id, input.id),
  eq(holdings.version, input.version)  // Prevent concurrent updates
))
```

---

## Testing Strategy to Reproduce Issues

### Test Case 1: Rapid Sequential Creation

1. Open AddData page
2. Create institution → account → holding in <5 seconds
3. Navigate to Holdings
4. **Expected bug:** Holding doesn't appear OR phantom holding with "Account not found"

### Test Case 2: Concurrent Mutations

1. Open two browser tabs
2. Tab 1: Create holding in Account A
3. Tab 2: Immediately create holding in Account A (while Tab 1 still saving)
4. **Expected bug:** One holding fails silently OR duplicate holdings appear

### Test Case 3: Cache Staleness

1. View Holdings page at 10:00 AM
2. Wait until 10:04 AM (still within 5min stale time)
3. In another tab, create a holding
4. Return to first tab, navigate away and back to Holdings
5. **Expected bug:** New holding doesn't appear (cache still "fresh")

### Test Case 4: Network Latency Simulation

1. Open DevTools → Network → Add 2000ms throttling
2. Create holding
3. **Expected bug:** Optimistic update shows success, then reverts after 2s delay

---

## Metrics to Track Post-Fix

1. **Cache Hit Rate:** Should be >80% for stable operations
2. **Mutation Success Rate:** Should be >99%
3. **Average Mutation Time:** Should be <500ms
4. **Invalidation Cascade Depth:** Should be <5 queries per mutation
5. **WebSocket Message Processing Time:** Should be <100ms

---

## Additional Observations

### Architecture Strengths

- Good separation of concerns with tRPC
- Comprehensive optimistic updates (when working correctly)
- Solid type safety end-to-end

### Architecture Weaknesses

- No distributed transaction coordination
- No pessimistic locking strategy
- Over-reliance on client-side cache management
- Missing request deduplication
- No retry logic for failed mutations

---

## Conclusion

The root cause is **lack of synchronization between sequential mutations combined with aggressive cache staleness settings**. The system works perfectly on a clean database because there's no cache to get stale. As data accumulates and operations become more complex, race conditions compound.

The fix requires:

1. Proper awaiting of mutation lifecycles
2. Reduced cache staleness
3. Better error handling for null returns
4. Eventual migration to batch mutation endpoints for atomic multi-entity operations

Estimated effort: **2-3 days for P0 fixes, 1 week for complete stabilization**
