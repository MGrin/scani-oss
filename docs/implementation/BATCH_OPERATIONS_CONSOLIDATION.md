# Batch Operations Consolidation

**Date:** 2025
**Status:** ✅ Complete

## Overview

Successfully consolidated two separate batch operation routes (`createHoldingWithDependencies` and `createHoldingsBatch`) into a single comprehensive `createHoldingsWithDependencies` mutation that handles atomic creation of institutions, accounts, and multiple holdings in a single transaction.

## Changes Made

### Backend Changes

#### 1. Updated Schema (`batch-operations.ts`)

**Before:** Two separate schemas

- `CreateHoldingWithDependenciesSchema` - Created institution + account + 1 holding
- `CreateHoldingsBatchSchema` - Created multiple holdings for existing account

**After:** Single unified schema with accountId option

```typescript
const CreateHoldingsWithDependenciesSchema = z.object({
  // Institution (optional - provide if needs to be created)
  institution: z.object({
    name: z.string().min(1, "Institution name is required"),
    type: z.string().min(1, "Institution type is required"),
    description: z.string().optional(),
    website: z.string().url().optional().or(z.literal("")),
  }).optional(),

  // Account - EITHER provide accountId (existing) OR account details (create new)
  accountId: z.string().uuid().optional(), // Use existing account
  account: z.object({
    institutionId: z.string().uuid().optional(),
    name: z.string().min(1, "Account name is required"),
    type: z.string().min(1, "Account type is required"),
    description: z.string().optional(),
  }).optional(), // Optional when accountId is provided

  // Holdings (required - at least one)
  holdings: z.array(
    z.object({
      tokenId: z.string().uuid().optional(),
      token: z.object({...}).optional(),
      balance: z.string().regex(/^-?\d+\.?\d*$/),
      lastUpdated: z.string().datetime().optional(),
    })
  ).min(1, "At least one holding is required"),
});
```

#### 2. Consolidated Router Implementation

**Before:** Two separate mutations

- `createHoldingWithDependencies` - Created dependencies + 1 holding
- `createHoldingsBatch` - Created multiple holdings only

**After:** Single mutation with intelligent routing

```typescript
createHoldingsWithDependencies: protectedProcedure
  .input(CreateHoldingsWithDependenciesSchema)
  .mutation(async ({ input, ctx }) => {
    // CASE 1: Using existing account - just create holdings
    if (input.accountId) {
      // Create all holdings for existing account in batch
      return { accountId: input.accountId, holdings: [...], createdAccount: false };
    }

    // CASE 2: Creating new account with holdings
    // Step 1: Create institution (if needed) + account + first holding
    // Step 2: Create remaining holdings
    // Returns comprehensive result with all holdings created
  })
```

**Key Features:**

- Handles both existing accounts (via `accountId`) and new account creation
- Creates institution when `input.institution` is provided
- Creates account using `batchOperationsService.createHoldingWithDependencies` for first holding
- Iterates through remaining holdings using `CreateHoldingUseCase`
- All operations in a single atomic transaction
- Returns detailed results for each holding created

**Key Features:**

- Handles institution creation when `input.institution` is provided
- Creates account using `batchOperationsService.createHoldingWithDependencies` for first holding
- Iterates through remaining holdings using `CreateHoldingUseCase`
- All operations in a single atomic transaction
- Returns detailed results for each holding created

### Frontend Changes

#### 1. Updated AddData.tsx Mutations

#### 1. Updated AddData.tsx Mutations

**Before:** Two separate mutations

```typescript
const createHoldingWithDependenciesMutation =
  trpc.batchOperations.createHoldingWithDependencies.useMutation({...});

const createHoldingsBatchMutation =
  trpc.batchOperations.createHoldingsBatch.useMutation({...});
```

**After:** Single unified mutation for all cases

````typescript
const createHoldingsWithDependenciesMutation =
  trpc.batchOperations.createHoldingsWithDependencies.useMutation({...});
```#### 2. Simplified Submission Logic

**Case 1: Creating New Account**

**Before:**

- Create institution + account + first holding
- Loop through remaining holdings and create in batch

**After:**

- Process ALL holdings upfront (convert external tokens)
- Create institution + account + ALL holdings in one mutation call
- Eliminates need for separate batch operation

```typescript
// Process all holdings - convert external tokens first
const processedHoldings = [];
for (const holding of newHoldingsToCreate) {
  let tokenId = holding.tokenValue;
  if (isExternalTokenValue(tokenId)) {
    const newToken = await createTokenFromExternalMutation.mutateAsync({...});
    tokenId = newToken.id;
  }
  processedHoldings.push({ tokenId, balance: holding.amount });
}

// Create everything atomically
const result = await createHoldingsWithDependenciesMutation.mutateAsync({
  institution: newAccountData.institutionSelection?.mode === "create"
    ? { name, type, description, website }
    : undefined,
  account: { institutionId, name, type },
  holdings: processedHoldings,
});
````

**Case 2: Using Existing Account**

**Before:** Used `createHoldingsBatch` mutation

**After:** Use unified mutation with `accountId` parameter

- The batch operation intelligently detects existing account via `accountId`
- Creates all holdings in batch using `CreateHoldingUseCase`
- No need for individual mutation calls or loops

```typescript
// Process holdings upfront
const processedHoldings = [];
for (const holding of newHoldingsToCreate) {
  let tokenId = holding.tokenValue;
  if (isExternalTokenValue(tokenId)) {
    const newToken = await createTokenFromExternalMutation.mutateAsync({...});
    tokenId = newToken.id;
  }
  processedHoldings.push({ tokenId, balance: holding.amount });
}

// Create all holdings in batch for existing account
await createHoldingsWithDependenciesMutation.mutateAsync({
  accountId, // Existing account ID
  holdings: processedHoldings,
});
```

## Benefits

### 1. **Simplified API Surface**

- Reduced from 2 batch operations to 1 unified operation
- Clearer intent: "Create holdings with their dependencies"
- Easier to understand and maintain

### 2. **Better Atomic Guarantees**

- All holdings created in a single transaction
- If any holding fails, entire operation rolls back
- No partial states or orphaned entities

### 3. **Reduced Code Duplication**

- Frontend no longer needs complex logic to split holdings
- Backend handles all the complexity internally
- Fewer mutation definitions to maintain

### 4. **Improved Type Safety**

- Single schema ensures consistency
- Holdings array properly typed with min(1) validation
- Result type includes all holdings created

### 5. **Better Error Handling**

- Single point of failure for all holding creation
- Comprehensive error reporting for each holding
- No need to coordinate errors across multiple mutations

### 6. **Improved Performance** ⭐ NEW

- **Eliminated N+1 mutation problem** for existing accounts
- Before: 1 mutation per holding (sequential API calls in a loop)
- After: 1 mutation for ALL holdings (single API call)
- Significantly faster for accounts with multiple holdings
- Reduces network overhead and improves UX

## Testing Checklist

- [ ] Create new account with multiple holdings (Case 1)
- [ ] Create new institution + account with multiple holdings
- [ ] Add holdings to existing account (Case 2)
- [ ] Test external token creation with batch operation
- [ ] Verify transaction rollback on failure
- [ ] Check query invalidation after successful creation
- [ ] Test error handling for invalid holdings

## Migration Notes

### Breaking Changes

- ❌ `createHoldingWithDependencies` - Removed
- ❌ `createHoldingsBatch` - Removed
- ✅ `createHoldingsWithDependencies` - New unified operation

### Frontend Impact

- AddData.tsx updated to use new mutation
- No changes needed elsewhere (other components don't use batch operations)

### Backend Impact

- Router implementation completely rewritten
- Service layer unchanged (still uses BatchOperationsService)
- Use cases unchanged (CreateHoldingUseCase still used for individual holdings)

## Future Improvements

1. **Batch Holdings Creation for Existing Accounts**

   - Could add an `accountId` parameter to `createHoldingsWithDependencies`
   - When provided, skip institution/account creation and just create holdings
   - Would eliminate the need for looping in Case 2

2. **Parallel Holding Creation**

   - Currently creates holdings sequentially
   - Could use `Promise.all()` for parallel creation
   - Needs careful transaction handling

3. **Better Progress Reporting**
   - Return progress updates for each holding created
   - Use WebSocket for real-time updates
   - Show progress bar in UI for large batches

## Files Changed

### Backend

- `apps/backend/src/presentation/routers/batch-operations.ts` - Schema and router consolidation

### Frontend

- `apps/frontendV2/src/pages/AddData.tsx` - Updated to use unified mutation

### Documentation

- `docs/implementation/BATCH_OPERATIONS_CONSOLIDATION.md` - This document

## Related Documentation

- [Clean Architecture with Use Cases](../features/CLEAN_ARCHITECTURE_USE_CASES.md)
- [Architecture Overview](../ARCHITECTURE.md)
- [Backend API Documentation](../technical/BACKEND_API.md)
