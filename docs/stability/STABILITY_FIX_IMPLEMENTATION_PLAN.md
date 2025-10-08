# Stability Fix Implementation Plan

**Date:** October 8, 2025
**Priority:** P0 - Critical Production Issues

## Overview

This document provides step-by-step implementation instructions for fixing the 7 critical stability issues identified in `STABILITY_ISSUES_ANALYSIS.md`.

---

## Phase 1: P0 Fixes (Day 1-2) - Critical Path

### Fix 1.1: Sequential Mutation Race Conditions in AddData.tsx

**Estimated Time:** 4 hours

**Files to modify:**

- `apps/frontend/src/pages/AddData.tsx`
- `apps/frontend/src/components/selectors/AccountSelectionWithCreation.tsx`

**Implementation:**

```typescript
// apps/frontend/src/pages/AddData.tsx

// ADD: Helper function to ensure cache is settled
const waitForCacheSettlement = async (
  queryKey: "institutions" | "accounts" | "holdings",
  expectedId?: string,
  maxRetries = 10
) => {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));

    let data;
    switch (queryKey) {
      case "institutions":
        data = utils.institutions.getAll.getData();
        break;
      case "accounts":
        data = utils.accounts.getAll.getData();
        break;
      case "holdings":
        data = utils.holdings.getAll.getData();
        break;
    }

    if (expectedId && data?.some((item) => item.id === expectedId)) {
      return true;
    }

    if (!expectedId && data) {
      return true;
    }
  }

  throw new Error(`Cache settlement timeout for ${queryKey}`);
};

// REPLACE: onSubmit function (lines ~890-1080)
const onSubmit = async (data: AddDataFormData) => {
  setIsSubmitting(true);

  try {
    let accountId = data.accountId || currentlySelectedAccountId;
    let tokenId = data.tokenId;
    let institutionId = data.institutionId;

    // Step 0: Create external token if needed
    if (tokenId === "new-external" && data.newExternalTokenSymbol) {
      try {
        const newToken = await createTokenFromExternal.mutateAsync({
          symbol: data.newExternalTokenSymbol.trim().toUpperCase(),
        });

        if (!newToken?.id) {
          throw new Error("Failed to create token - no ID returned");
        }

        tokenId = newToken.id;

        // CRITICAL: Wait for token to appear in cache
        await waitForCacheSettlement("holdings", tokenId);
      } catch (error) {
        console.error("External token creation failed:", error);
        throw new Error(
          `Failed to create token: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    }

    // Step 1: Create institution if needed
    if (accountId === "new" && data.institutionId === "new") {
      try {
        const newInstitution = await createInstitution.mutateAsync({
          name: data.newInstitutionName!.trim(),
          type: data.newInstitutionType!,
          description: data.newInstitutionDescription?.trim() || "",
          website: data.newInstitutionWebsite?.trim() || "",
        });

        if (!newInstitution?.id) {
          throw new Error("Failed to create institution - no ID returned");
        }

        institutionId = newInstitution.id;

        // CRITICAL FIX: Wait for institution to settle in cache
        await waitForCacheSettlement("institutions", institutionId);

        console.log("Institution created and settled:", institutionId);
      } catch (error) {
        console.error("Institution creation failed:", error);
        throw error;
      }
    }

    // Step 2: Create account if needed
    if (accountId === "new") {
      try {
        if (!institutionId || institutionId === "new") {
          throw new Error("Institution ID is required to create an account");
        }

        const newAccount = await createAccount.mutateAsync({
          name: data.newAccountName!.trim(),
          type: data.newAccountType!,
          institutionId: institutionId,
          description: data.newAccountDescription?.trim() || "",
        });

        if (!newAccount?.id) {
          throw new Error("Failed to create account - no ID returned");
        }

        accountId = newAccount.id;

        // CRITICAL FIX: Wait for account to settle in cache
        await waitForCacheSettlement("accounts", accountId);

        console.log("Account created and settled:", accountId);
      } catch (error) {
        console.error("Account creation failed:", error);
        throw error;
      }
    }

    // Step 3: Create holding
    try {
      if (!accountId || !tokenId || accountId === "new" || tokenId === "new") {
        throw new Error(
          `Missing required IDs - Account: ${accountId}, Token: ${tokenId}`
        );
      }

      const createdHolding = await createHolding.mutateAsync({
        accountId,
        tokenId,
        balance: data.balance.toString(),
      });

      if (!createdHolding?.id) {
        throw new Error("Failed to create holding - no ID returned");
      }

      // CRITICAL FIX: Wait for holding to settle in cache
      await waitForCacheSettlement("holdings", createdHolding.id);

      console.log("Holding created and settled:", createdHolding.id);

      toast({
        title: "✅ Success!",
        description: "Holding created successfully!",
      });

      // CRITICAL FIX: Ensure all invalidations complete before navigation
      await Promise.all([
        utils.holdings.getAll.invalidate(),
        utils.accounts.getAll.invalidate(),
        utils.institutions.getAll.invalidate(),
        utils.tokens.getAll.invalidate(),
      ]);

      // Give React Query time to process invalidations
      await new Promise((resolve) => setTimeout(resolve, 100));

      navigate("/holdings");
    } catch (error) {
      console.error("Holding creation failed:", error);
      throw error;
    }
  } catch (error) {
    console.error("Overall submission failed:", error);

    toast({
      title: "❌ Error Creating Holding",
      description:
        error instanceof Error ? error.message : "An unexpected error occurred",
      variant: "destructive",
    });
  } finally {
    setIsSubmitting(false);
  }
};
```

**Testing:**

1. Create institution → account → holding rapidly
2. Verify all entities appear in UI immediately
3. Navigate to Holdings page - verify holding is visible
4. Check browser console for "settled" log messages

---

### Fix 1.2: Null Return Handling in Optimistic Updates

**Estimated Time:** 3 hours

**Files to modify:**

- `apps/frontend/src/lib/cache/optimistic/entityManager.ts`

**Implementation:**

```typescript
// apps/frontend/src/lib/cache/optimistic/entityManager.ts

// REPLACE: getHoldingCreateHandlers.onSuccess (lines ~396-420)
async onSuccess(result, variables, context) {
  const created = result as Holding | null;

  // CRITICAL FIX: Handle null returns properly
  if (!created) {
    // Remove optimistic entity from cache
    if (context?.tempId) {
      utils.holdings.getAll.setData(undefined, (current) =>
        removeEntity(current, context.tempId!)
      );
    }

    console.error('Holding creation returned null', {
      variables,
      context,
    });

    // Don't throw here - let onError handle it
    return;
  }

  const normalized: Holding = {
    ...created,
    balance: asStringValue(created.balance, '0'),
    createdAt: asIsoString(created.createdAt),
    lastUpdated: asIsoString(created.lastUpdated),
  } as Holding;

  const targetId = context?.tempId ?? normalized.id;

  utils.holdings.getAll.setData(undefined, (current) =>
    replaceEntityById(current, targetId, normalized)
  );

  // Force invalidation to ensure fresh data
  await utils.holdings.getById.invalidate({ id: normalized.id });
},

// SAME PATTERN for all other entity handlers:
// - getAccountCreateHandlers.onSuccess
// - getInstitutionCreateHandlers.onSuccess
// - getTokenCreateHandlers.onSuccess
// - getTransactionCreateHandlers.onSuccess
```

**Apply same pattern to:**

- Lines 288-320 (Account create)
- Lines 134-167 (Institution create)
- Lines 622-680 (Token create)
- Lines 733-780 (Transaction create)

**Testing:**

1. Create holding with duplicate accountId+tokenId
2. Verify optimistic update is removed when backend returns null
3. Verify error toast appears
4. Check that phantom holdings don't persist in cache

---

### Fix 1.3: Reduce Cache Staleness Settings

**Estimated Time:** 1 hour

**Files to modify:**

- `apps/frontend/src/lib/trpc-provider.tsx`
- `apps/frontend/src/contexts/EntityDataContext.tsx`

**Implementation:**

```typescript
// apps/frontend/src/lib/trpc-provider.tsx

export function TRPCProvider({ children }: TRPCProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,

            // CRITICAL FIX: Reduce stale time to prevent cache issues
            staleTime: 30 * 1000, // 30 seconds (was 5 minutes)
            gcTime: 5 * 60 * 1000, // 5 minutes (was 10 minutes)

            // CRITICAL FIX: Always refetch on mount to ensure fresh data
            refetchOnMount: "always", // (was false)

            // Enable background refetch for stale queries
            refetchOnReconnect: true,

            // Prevent multiple identical requests in flight
            networkMode: "online",
          },
          mutations: {
            // Add retry logic for transient failures
            retry: 1,
            networkMode: "online",
          },
        },
      })
  );

  // ... rest unchanged
}
```

```typescript
// apps/frontend/src/contexts/EntityDataContext.tsx

const DEFAULT_QUERY_OPTIONS = {
  // REMOVE: staleTime, gcTime, refetchOnMount
  // They're now set globally in TRPCProvider

  // Keep only:
  retry: 1,
};
```

**Remove manual refetchOnMount overrides in:**

- `apps/frontend/src/pages/Institutions.tsx` (lines 47, 55, 58)
- `apps/frontend/src/pages/Accounts.tsx` (lines 82, 89)
- `apps/frontend/src/pages/Holdings.tsx` (line 51)

**Testing:**

1. Create holding at time T
2. Wait 45 seconds
3. Navigate away and back
4. Verify data refetches automatically
5. Monitor network tab - should see fresh requests

---

## Phase 2: P0 Fixes (Day 2-3) - Error Handling

### Fix 2.1: Make All Invalidation Functions Return Promises

**Estimated Time:** 2 hours

**Files to modify:**

- `apps/frontend/src/lib/cache/invalidation.ts`

**Implementation:**

```typescript
// apps/frontend/src/lib/cache/invalidation.ts

// CHANGE return type from void to Promise<void>
export async function invalidateHoldingsRelated(
  utils: TrpcUtils,
  {
    holdingIds = [],
    includeAccountSummaries = true,
    includePortfolioValue = false,
  }: HoldingsInvalidationOptions = {}
): Promise<void> {
  const tasks: InvalidationTask[] = [];

  if (utils.holdings?.getAll) {
    tasks.push(utils.holdings.getAll.invalidate());
  }

  if (utils.holdings?.getUnpriceableTokens) {
    tasks.push(utils.holdings.getUnpriceableTokens.invalidate());
  }

  if (includeAccountSummaries) {
    tasks.push(utils.accounts.getSummaries.invalidate());
  }

  if (includePortfolioValue) {
    tasks.push(utils.users.getPortfolioValue.invalidate());
  }

  if (holdingIds.length && utils.holdings?.getById) {
    for (const holdingId of holdingIds) {
      tasks.push(utils.holdings.getById.invalidate({ id: holdingId }));
    }
  }

  await runInvalidations(tasks);
}

// APPLY SAME PATTERN TO:
// - invalidateAccountsRelated
// - invalidateInstitutionsRelated
// - invalidateTokensRelated
// - invalidateTransactionsRelated
// - invalidatePortfolioValue
```

**Update all call sites** to await invalidation functions:

```typescript
// Before:
void invalidateHoldingsRelated(utils, {...});

// After:
await invalidateHoldingsRelated(utils, {...});
```

**Files to update:**

- `apps/frontend/src/hooks/useRealtimeEntitySync.ts`
- `apps/frontend/src/pages/AddData.tsx`
- All form components using invalidations

**Testing:**

1. Create entity and monitor when navigation occurs
2. Verify navigation happens AFTER invalidation completes
3. New page should show fresh data immediately

---

### Fix 2.2: Replace .mutate() with .mutateAsync()

**Estimated Time:** 2 hours

**Files to modify:**

- `apps/frontend/src/components/HoldingForm.tsx`
- `apps/frontend/src/components/TransactionForm.tsx`
- All delete operations

**Implementation:**

```typescript
// apps/frontend/src/components/HoldingForm.tsx

// REPLACE lines 288-320:
const onSubmit = async (data: HoldingFormData) => {
  setIsSubmitting(true);

  try {
    // Process account creation if needed
    let accountId = data.accountId;
    if (data.accountId === "new") {
      accountId = await processAccountCreation(data, accountMutations);
    }

    const submitData = {
      accountId,
      tokenId: data.tokenId,
      balance: data.balance,
    };

    console.log("Submitting to backend:", submitData);

    if (mode === "create") {
      // CHANGE: Use mutateAsync instead of mutate
      const result = await createHolding.mutateAsync(submitData);

      if (!result?.id) {
        throw new Error("Failed to create holding - no ID returned");
      }

      const hasBalance = parseFloat(result.balance) > 0;
      toast({
        title: "Holding created successfully! ✅",
        description: hasBalance
          ? "Your new holding and opening balance have been added."
          : "Your new holding has been added to your portfolio.",
      });
    } else if (holding) {
      // CHANGE: Use mutateAsync instead of mutate
      await updateHolding.mutateAsync({
        id: holding.id,
        data: submitData,
      });

      toast({
        title: "Holding updated",
        description: "Your holding has been successfully updated.",
      });
    }

    handleFormReset();
    onClose();
  } catch (error) {
    console.error("Error in form submission:", error);
    toast({
      title: "Error",
      description:
        error instanceof Error ? error.message : "An unexpected error occurred",
      variant: "destructive",
    });
  } finally {
    setIsSubmitting(false);
  }
};
```

**Apply same pattern to:**

- `apps/frontend/src/components/TransactionForm.tsx` (lines 381-386)
- `apps/frontend/src/pages/Holdings.tsx` (line 268 - delete mutation)
- `apps/frontend/src/pages/Institutions.tsx` (line 91 - delete mutation)
- `apps/frontend/src/pages/Accounts.tsx` (line 178 - delete mutation)
- `apps/frontend/src/pages/Transactions.tsx` (line 331 - delete mutation)

**Testing:**

1. Submit form with invalid data
2. Verify error toast appears
3. Verify loading state clears
4. Verify form can be resubmitted

---

## Phase 3: P1 Fixes (Day 3-4) - Performance & WebSocket

### Fix 3.1: WebSocket Invalidations with Guaranteed Refetch

**Estimated Time:** 3 hours

**Files to modify:**

- `apps/frontend/src/hooks/useRealtimeEntitySync.ts`

**Implementation:**

```typescript
// apps/frontend/src/hooks/useRealtimeEntitySync.ts

// REPLACE handleMessage function (lines ~48-155)
const handleMessage = useCallback(
  async (message: WebSocketMessage) => {
    if (message.type !== "entity_changed") {
      return;
    }

    const payload = message as EntityChangedMessage;
    const entityType = payload.entityType;

    if (!entityType) {
      return;
    }

    const entityId = payload.entityId;
    const related = payload.metadata?.relatedEntities ?? [];
    const data = payload.data ?? {};

    // CRITICAL FIX: Await invalidations and force refetch
    try {
      switch (entityType) {
        case "account":
          await invalidateAccountsRelated(utils, {
            includePortfolioValue: true,
            accountIds: entityId ? [entityId] : [],
          });

          // Force refetch of critical queries
          await utils.accounts.getAll.refetch();

          if (related.length) {
            const institutionIds = related
              .filter((entity) => entity.type === "institution")
              .map((entity) => entity.id);
            if (institutionIds.length) {
              await invalidateInstitutionsRelated(utils, {
                includeAccounts: true,
                institutionIds,
              });
            }
          }
          break;

        case "holding":
          await invalidateHoldingsRelated(utils, {
            holdingIds: entityId ? [entityId] : [],
          });

          // Force refetch of holdings
          await utils.holdings.getAll.refetch();

          if (related.length) {
            const accountIds = related
              .filter((entity) => entity.type === "account")
              .map((entity) => entity.id);
            if (accountIds.length) {
              await invalidateAccountsRelated(utils, {
                includeSummaries: false,
                accountIds,
              });
            }
          }
          break;

        // ... other cases with same pattern
      }
    } catch (error) {
      console.error("WebSocket message processing error:", error);
    }
  },
  [utils]
);
```

**Testing:**

1. Open two browser tabs
2. Create holding in Tab 1
3. Verify Tab 2 updates within 1 second
4. Check network tab for refetch requests

---

### Fix 3.2: Reduce Refetch Cascades

**Estimated Time:** 4 hours

**Files to modify:**

- `apps/frontend/src/lib/cache/refresh.ts`

**Implementation:**

```typescript
// apps/frontend/src/lib/cache/refresh.ts

export function refreshHoldingsViews(
  utils: TrpcUtils,
  {
    holdingIds = [],
    accountIds = [],
    institutionIds = [],
    cascadeTransactions = false,
  }: HoldingRefreshOptions = {}
) {
  // CRITICAL FIX: Only invalidate, don't force refetch
  // React Query will refetch automatically when components mount
  const tasks: Array<Promise<unknown>> = [
    invalidateHoldingsRelated(utils, {
      holdingIds,
      includeAccountSummaries: false,
      includePortfolioValue: true,
    }),
    invalidateAccountsRelated(utils, {
      accountIds,
      includeSummaries: true,
      includePortfolioValue: true,
    }),
    invalidateTokensRelated(utils),
  ];

  // REMOVE: Force refetches
  // These cause cascade of 15+ requests
  // Let React Query handle it lazily

  if (institutionIds.length > 0) {
    tasks.push(
      invalidateInstitutionsRelated(utils, {
        institutionIds,
        includeAccounts: true,
        includeByUser: true,
      })
    );
  }

  if (cascadeTransactions) {
    tasks.push(invalidateTransactionsRelated(utils));
  }

  return collectTasks(tasks);
}
```

**Apply same pattern to:**

- `refreshAccountsViews()` (lines 59-93)
- `refreshInstitutionsViews()` (lines 15-51)
- `refreshTokensViews()` (lines 155-187)
- `refreshTransactionsViews()` (lines 189-213)

**Testing:**

1. Create holding
2. Monitor network tab
3. Count HTTP requests
4. Should be <5 requests (was 15+)

---

## Phase 4: P2 Fixes (Day 4-5) - Long-term Stability

### Fix 4.1: Backend Batch Mutation Endpoint

**Estimated Time:** 6 hours

**Files to create:**

- `apps/backend/src/routers/batch-operations.ts`

**Implementation:**

```typescript
// apps/backend/src/routers/batch-operations.ts

import { CreateHoldingSchema } from "@scani/shared/types";
import { z } from "zod";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { getUserId } from "../middleware/auth";
import { protectedProcedure, router } from "../trpc";

const CreateHoldingWithDependenciesSchema = z.object({
  // Institution (optional, create if missing)
  institution: z
    .object({
      name: z.string(),
      type: z.string(),
      description: z.string().optional(),
      website: z.string().optional(),
    })
    .optional(),

  // Account (required)
  account: z.object({
    institutionId: z.string().optional(), // If institution created, use that ID
    name: z.string(),
    type: z.string(),
    description: z.string().optional(),
  }),

  // Holding (required)
  holding: CreateHoldingSchema,

  // Token (optional, create if external)
  token: z
    .object({
      symbol: z.string(),
    })
    .optional(),
});

export const batchOperationsRouter = router({
  createHoldingWithDependencies: protectedProcedure
    .input(CreateHoldingWithDependenciesSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const now = new Date();

      // CRITICAL: Use database transaction for atomicity
      return await db.transaction(async (tx) => {
        let institutionId: string | undefined;
        let accountId: string;
        let tokenId: string;

        // Step 1: Create institution if needed
        if (input.institution) {
          const [institutionType] = await tx
            .select()
            .from(schema.institutionTypes)
            .where(eq(schema.institutionTypes.code, input.institution.type))
            .limit(1);

          if (!institutionType) {
            throw new Error(
              `Invalid institution type: ${input.institution.type}`
            );
          }

          const [institution] = await tx
            .insert(schema.institutions)
            .values({
              userId,
              name: input.institution.name.trim(),
              typeId: institutionType.id,
              description: input.institution.description?.trim() || null,
              website: input.institution.website?.trim() || null,
              isActive: true,
              createdAt: now,
              updatedAt: now,
            })
            .returning();

          if (!institution) {
            throw new Error("Failed to create institution");
          }

          institutionId = institution.id;
        } else {
          institutionId = input.account.institutionId;
        }

        if (!institutionId) {
          throw new Error("Institution ID is required");
        }

        // Step 2: Create account
        const [accountType] = await tx
          .select()
          .from(schema.accountTypes)
          .where(eq(schema.accountTypes.code, input.account.type))
          .limit(1);

        if (!accountType) {
          throw new Error(`Invalid account type: ${input.account.type}`);
        }

        const [account] = await tx
          .insert(schema.accounts)
          .values({
            userId,
            institutionId,
            name: input.account.name.trim(),
            typeId: accountType.id,
            description: input.account.description?.trim() || null,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        if (!account) {
          throw new Error("Failed to create account");
        }

        accountId = account.id;

        // Step 3: Create token if needed
        if (input.token) {
          // Implement token creation logic
          // ...
        }

        tokenId = input.holding.tokenId;

        // Step 4: Create holding
        const [holding] = await tx
          .insert(schema.holdings)
          .values({
            userId,
            accountId,
            tokenId,
            balance: input.holding.balance || "0",
            createdAt: now,
            lastUpdated: now,
          })
          .returning();

        if (!holding) {
          throw new Error("Failed to create holding");
        }

        // Step 5: Create opening balance transaction if needed
        if (parseFloat(holding.balance) > 0) {
          const [depositType] = await tx
            .select()
            .from(schema.transactionTypes)
            .where(eq(schema.transactionTypes.code, "deposit"))
            .limit(1);

          if (!depositType) {
            throw new Error("Deposit transaction type not found");
          }

          await tx.insert(schema.transactions).values({
            userId,
            holdingId: holding.id,
            typeId: depositType.id,
            amount: holding.balance,
            fee: "0",
            description: "Opening balance - initial holding position",
            timestamp: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        return {
          institution: institutionId,
          account: accountId,
          holding: holding.id,
        };
      });
    }),
});
```

**Update router:**

```typescript
// apps/backend/src/router.ts

import { batchOperationsRouter } from "./routers/batch-operations";

export const appRouter = router({
  // ... existing routers
  batch: batchOperationsRouter,
});
```

**Update frontend to use batch endpoint:**

```typescript
// apps/frontend/src/pages/AddData.tsx

const createHoldingBatch = trpc.batch.createHoldingWithDependencies.useMutation(
  withOptimisticHandlers("holding", "create", utils)
);

// In onSubmit:
const result = await createHoldingBatch.mutateAsync({
  institution:
    institutionId === "new"
      ? {
          name: data.newInstitutionName!,
          type: data.newInstitutionType!,
          description: data.newInstitutionDescription,
          website: data.newInstitutionWebsite,
        }
      : undefined,
  account: {
    institutionId: institutionId !== "new" ? institutionId : undefined,
    name: data.newAccountName!,
    type: data.newAccountType!,
    description: data.newAccountDescription,
  },
  holding: {
    accountId: "", // Will be set by backend
    tokenId: data.tokenId,
    balance: data.balance.toString(),
  },
});

// All-or-nothing guarantee - no orphaned entities!
```

**Testing:**

1. Create holding with new institution+account
2. Simulate network failure mid-operation
3. Verify NOTHING is created (atomicity)
4. Retry - verify success creates all entities

---

## Testing Checklist

### Regression Tests

- [ ] Create institution → account → holding rapidly (<5s)
- [ ] Create multiple holdings in same account concurrently
- [ ] Navigate between pages during mutations
- [ ] Open 2 tabs, create holdings in both simultaneously
- [ ] Simulate slow network (2s latency)
- [ ] Create holdings with duplicate account+token
- [ ] Delete institution with cascade
- [ ] Update holding balance multiple times rapidly

### Performance Tests

- [ ] Count HTTP requests per mutation (<5 expected)
- [ ] Measure mutation completion time (<500ms expected)
- [ ] Monitor cache hit rate (>80% expected)
- [ ] Check WebSocket message processing (<100ms expected)

### Data Consistency Tests

- [ ] Create entity, refresh page, verify persisted
- [ ] Create entity, navigate away, navigate back, verify visible
- [ ] Create entity in Tab 1, verify appears in Tab 2
- [ ] Delete entity, verify cascade deletes dependencies

---

## Rollout Strategy

### Phase 1: Deploy P0 Fixes (Critical)

1. Deploy Fix 1.1, 1.2, 1.3 together
2. Monitor error rates for 24 hours
3. If stable, proceed to Phase 2

### Phase 2: Deploy Error Handling (P0)

1. Deploy Fix 2.1, 2.2
2. Monitor mutation success rates
3. If stable, proceed to Phase 3

### Phase 3: Deploy Performance Fixes (P1)

1. Deploy Fix 3.1, 3.2
2. Monitor request counts and loading times
3. If stable, proceed to Phase 4

### Phase 4: Deploy Batch Endpoint (P2)

1. Deploy Fix 4.1 as opt-in feature flag
2. Test with 10% of users
3. Gradually increase to 100%

---

## Monitoring & Alerts

### Metrics to Track

```
- mutation_success_rate (target: >99%)
- mutation_duration_p95 (target: <500ms)
- cache_hit_rate (target: >80%)
- websocket_message_latency_p95 (target: <100ms)
- concurrent_mutations_count (track for bottlenecks)
- optimistic_update_revert_rate (target: <1%)
```

### Alerts to Set

```
- Alert if mutation_success_rate < 95%
- Alert if mutation_duration_p95 > 1000ms
- Alert if cache_hit_rate < 60%
- Alert if optimistic_update_revert_rate > 5%
```

---

## Estimated Total Effort

- **P0 Fixes (Phase 1-2):** 2-3 days
- **P1 Fixes (Phase 3):** 1 day
- **P2 Fixes (Phase 4):** 1-2 days
- **Testing & QA:** 1 day
- **Documentation:** 0.5 days

**Total:** 5.5 - 7.5 days for complete stabilization

---

## Success Criteria

✅ All 7 identified issues are fixed
✅ Mutation success rate >99%
✅ No phantom entities in cache
✅ Consistent data across tabs/sessions
✅ Sub-500ms mutation times
✅ <5 HTTP requests per mutation
✅ Zero regression in existing features

---

## Next Steps

1. Review this plan with team
2. Prioritize fixes based on impact
3. Create Jira/Linear tickets for each fix
4. Assign owners
5. Start with Phase 1 P0 fixes
6. Daily standups to track progress

**Contact:** @mgrin for questions/clarifications
