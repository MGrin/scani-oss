# Scani Stability Issues - Quick Debugging Guide

## 🔍 How to Identify Which Issue You're Seeing

### Symptom: "Holding created but doesn't appear in list"

**Likely Issue:** #1 (Sequential Mutation Race) or #4 (Cache Staleness)

**Quick Debug:**

1. Open DevTools Console
2. Check for "Created successfully" log
3. Look at Network tab - is there a 200 response?
4. Run in console: `queryClient.getQueryData(['holdings', 'getAll'])`
5. If data is there but UI not showing → **Issue #4 (Cache Staleness)**
6. If data missing from cache → **Issue #1 (Race Condition)**

**Quick Fix:**

```javascript
// In browser console:
// Force refetch
queryClient.invalidateQueries({ queryKey: ["holdings"] });
```

---

### Symptom: "Account does not exist" error right after creating account

**Likely Issue:** #1 (Sequential Mutation Race)

**Quick Debug:**

1. Check Network tab for account creation - did it succeed?
2. Look for "Creating holding" log immediately after "Account created"
3. If <100ms between them → **Issue #1 confirmed**

**Quick Fix:**

```javascript
// Add delay in your code:
await new Promise((resolve) => setTimeout(resolve, 200));
```

---

### Symptom: "Success toast but holding is phantom (shows 'Account not found')"

**Likely Issue:** #3 (Null Return in onSuccess)

**Quick Debug:**

1. Check Network tab for holding creation
2. Look at Response body - is it `null`?
3. Check Console for "Backend returned null" error
4. If optimistic entity still in cache → **Issue #3 confirmed**

**Quick Fix:**

```javascript
// In browser console:
// Clear phantom entities
queryClient.setQueryData(["holdings", "getAll"], (old) =>
  old?.filter((h) => !h.id.startsWith("temp-"))
);
```

---

### Symptom: "Loading spinner hangs forever"

**Likely Issue:** #7 (Using .mutate() instead of .mutateAsync())

**Quick Debug:**

1. Check Console for errors (they may be silent)
2. Look for mutation in Network tab - did it fail?
3. Check component state - is `isSubmitting` still `true`?
4. If state stuck → **Issue #7 confirmed**

**Quick Fix:**

```javascript
// In browser console:
// Force component re-render
window.location.reload();
```

---

### Symptom: "Random slow loading (sometimes fast, sometimes 5s+)"

**Likely Issue:** #4 (Cache Staleness) + #8 (Refetch Cascades)

**Quick Debug:**

1. Open Network tab
2. Count requests when navigating to Holdings page
3. If >10 requests → **Issue #8 (Refetch Cascades)**
4. If some instant, some slow → **Issue #4 (Cache Staleness)**

**Quick Fix:**

```javascript
// In browser console:
// Reduce stale time temporarily
queryClient.setDefaultOptions({
  queries: { staleTime: 0 },
});
```

---

### Symptom: "Created in one tab but doesn't appear in other tab"

**Likely Issue:** #5 (WebSocket Invalidation)

**Quick Debug:**

1. Open both tabs' DevTools Console
2. Look for "WebSocket message received" in Tab 2
3. If message received but UI not updating → **Issue #5 confirmed**
4. If no message → Check WebSocket connection status

**Quick Fix:**

```javascript
// In browser console (Tab 2):
// Manually trigger refetch
queryClient.refetchQueries({ queryKey: ["holdings"] });
```

---

### Symptom: "Orphaned institutions/accounts after failed holding creation"

**Likely Issue:** #6 (Non-Atomic Multi-Entity Creation)

**Quick Debug:**

1. Check Network tab - did institution/account creation succeed?
2. Did holding creation fail?
3. If yes to both → **Issue #6 confirmed**

**Quick Fix:**

```sql
-- Manually clean up orphans:
DELETE FROM institutions
WHERE id NOT IN (SELECT DISTINCT institution_id FROM accounts);
```

---

## 🛠️ Browser Console Debugging Commands

### View Current Cache State

```javascript
// See all holdings
queryClient.getQueryData(["holdings", "getAll"]);

// See all accounts
queryClient.getQueryData(["accounts", "getAll"]);

// See specific holding
queryClient.getQueryData(["holdings", "getById", { id: "HOLDING_ID" }]);
```

### Force Refetch Everything

```javascript
// Nuclear option - refetch all queries
queryClient.refetchQueries();

// Selective refetch
queryClient.refetchQueries({ queryKey: ["holdings"] });
queryClient.refetchQueries({ queryKey: ["accounts"] });
```

### Clear Optimistic Updates

```javascript
// Remove all temp entities
["holdings", "accounts", "institutions", "tokens"].forEach((key) => {
  queryClient.setQueryData([key, "getAll"], (old) =>
    old?.filter((entity) => !entity.id.startsWith("temp-"))
  );
});
```

### Check Query Staleness

```javascript
// See which queries are stale
queryClient
  .getQueryCache()
  .getAll()
  .filter((q) => q.isStale())
  .map((q) => q.queryKey);
```

### Monitor Mutations in Flight

```javascript
// See active mutations
queryClient
  .getMutationCache()
  .getAll()
  .filter((m) => m.state.status === "pending");
```

---

## 📊 Performance Monitoring Commands

### Count HTTP Requests

```javascript
// Run before action, then after
const before = performance.getEntriesByType("resource").length;
// ... perform action ...
const after = performance.getEntriesByType("resource").length;
console.log(`Made ${after - before} HTTP requests`);
```

### Measure Mutation Time

```javascript
// Add to mutation onMutate:
const startTime = performance.now();
// Add to mutation onSettled:
const duration = performance.now() - startTime;
console.log(`Mutation took ${duration}ms`);
```

### Check WebSocket Status

```javascript
// In console:
// Check if WebSocket is connected
// (you'll need to expose this from useWebSocket hook)
```

---

## 🧪 Testing Scenarios to Reproduce Issues

### Test 1: Race Condition Test

```
1. Open DevTools Console
2. Paste:
   const test = async () => {
     for (let i = 0; i < 5; i++) {
       await createHolding.mutateAsync({...});
     }
   };
   test();
3. Check if all 5 holdings appear
```

### Test 2: Cache Staleness Test

```
1. Load Holdings page at time T
2. Wait 3 minutes
3. In another tab, create holding
4. Return to first tab
5. Navigate to Accounts, then back to Holdings
6. Check if new holding appears (should be missing due to stale cache)
```

### Test 3: Concurrent Mutation Test

```
1. Open 2 browser tabs
2. Both tabs: Navigate to Add Data
3. Fill form identically in both tabs
4. Click Submit in both tabs within 1 second
5. Check for duplicate/failed holdings
```

### Test 4: Network Latency Test

```
1. DevTools → Network → Add custom profile:
   - Download: 1Mbps
   - Upload: 500kbps
   - Latency: 2000ms
2. Try creating holding
3. Watch for optimistic update → revert → error pattern
```

---

## 🚨 Emergency Fixes

### User Reports "My data is stuck"

**Nuclear Option:**

```javascript
// In browser console:
localStorage.clear();
queryClient.clear();
window.location.reload();
```

### User Reports "Phantom holdings that won't delete"

```javascript
// In browser console:
queryClient.setQueryData(["holdings", "getAll"], (old) =>
  old?.filter((h) => !h.id.startsWith("temp-"))
);
queryClient.refetchQueries({ queryKey: ["holdings"] });
```

### Database Cleanup for Orphaned Entities

```sql
-- Run in PostgreSQL:

-- Find orphaned accounts (no holdings)
SELECT a.id, a.name, i.name as institution
FROM accounts a
LEFT JOIN holdings h ON h.account_id = a.id
LEFT JOIN institutions i ON i.id = a.institution_id
WHERE h.id IS NULL;

-- Find orphaned institutions (no accounts)
SELECT i.id, i.name, i.created_at
FROM institutions i
LEFT JOIN accounts a ON a.institution_id = i.id
WHERE a.id IS NULL;

-- Find holdings with invalid references
SELECT h.id, h.account_id, h.token_id
FROM holdings h
LEFT JOIN accounts a ON a.id = h.account_id
LEFT JOIN tokens t ON t.id = h.token_id
WHERE a.id IS NULL OR t.id IS NULL;
```

---

## 📝 Logging Best Practices

### Add to Mutations for Debugging

```typescript
// Add to all mutateAsync calls:
try {
  console.log("[MUTATION START]", mutationName, input);
  const result = await someMutation.mutateAsync(input);
  console.log("[MUTATION SUCCESS]", mutationName, result);
  return result;
} catch (error) {
  console.error("[MUTATION ERROR]", mutationName, error);
  throw error;
}
```

### Add to Cache Updates

```typescript
// Add to optimistic update handlers:
onMutate: (input) => {
  console.log('[OPTIMISTIC] Adding temp entity', tempId);
  // ... update cache
  return { tempId };
},
onSuccess: (result, variables, context) => {
  console.log('[OPTIMISTIC] Replacing with real entity', {
    tempId: context?.tempId,
    realId: result?.id
  });
  // ... replace cache
},
```

---

## 🎯 Red Flags to Watch For

### In Network Tab

- ❌ Multiple identical requests in parallel
- ❌ Requests taking >1s to complete
- ❌ 500 errors from backend
- ❌ Requests with stale auth tokens

### In Console

- ❌ "Backend returned null" warnings
- ❌ "Failed to create..." errors
- ❌ Unhandled promise rejections
- ❌ WebSocket disconnection messages

### In React DevTools

- ❌ Components re-rendering >5 times per second
- ❌ Query status stuck in "loading"
- ❌ Mutation status stuck in "pending"
- ❌ State not updating after mutations

### In Database

- ❌ Holdings with non-existent account_id
- ❌ Accounts with non-existent institution_id
- ❌ Transactions with non-existent holding_id
- ❌ Duplicate holdings (same account + token)

---

## 📞 When to Escalate

**Escalate immediately if:**

- Data loss occurs (entities deleted unintentionally)
- Multiple users report same issue concurrently
- Issue persists after page refresh
- Backend errors (500s) in production
- Database constraint violations

**Can be deferred if:**

- Issue only on single user's machine
- Issue resolves after page refresh
- No data loss involved
- User can work around by retrying

---

## 🔗 Related Documentation

- Full analysis: `STABILITY_ISSUES_ANALYSIS.md`
- Implementation plan: `STABILITY_FIX_IMPLEMENTATION_PLAN.md`
- Architecture docs: `docs/ARCHITECTURE.md`

---

**Last Updated:** October 8, 2025
**Maintained By:** @mgrin
