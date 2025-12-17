# Plaid Reconnection Fix - Unique Constraint Violation

**Date:** 2025-12-17  
**Issue:** Database insert failure when reconnecting Plaid institutions  
**Status:** ✅ Fixed  
**Files Modified:** 1

---

## Problem Statement

The Plaid integration was failing with the following error when users attempted to reconnect their bank accounts:

```
Failed query: insert into "plaid_items" 
  ("id", "user_id", "institution_id", "plaid_item_id", "plaid_access_token", 
   "plaid_institution_id", "is_active", ...) 
values (default, $1, $2, $3, $4, $5, $6, ...)
```

### Root Cause Analysis

The `plaid_items` table has a unique constraint on `(user_id, institution_id)`:

```sql
CONSTRAINT "plaid_items_user_id_institution_id_unique" 
  UNIQUE("user_id","institution_id")
```

This constraint ensures that each user can only have one active Plaid connection per institution.

**The Bug:**
1. User connects a bank → `plaid_items` record created with `plaid_item_id = "xyz"`
2. User disconnects the bank (record may remain in database)
3. User reconnects the same bank → Plaid generates a new `plaid_item_id = "abc"`
4. Code checks: `SELECT ... WHERE plaid_item_id = "abc"` → returns nothing (new ID)
5. Code attempts: `INSERT INTO plaid_items ...` → **FAILS** due to unique constraint on `(user_id, institution_id)`

The code was checking by the wrong key (`plaid_item_id`) when it should have been checking by the unique constraint keys (`user_id`, `institution_id`).

---

## Solution

### Changes Made

**File:** `packages/core/src/use-cases/ExchangePlaidTokenUseCase.ts`

1. **Import `and` operator:**
   ```typescript
   import { and, eq } from 'drizzle-orm';
   ```

2. **Updated `createOrUpdatePlaidItem()` method:**

   **Before:**
   ```typescript
   // Check if item already exists
   const [existingItem] = await db
     .select()
     .from(schema.plaidItems)
     .where(eq(schema.plaidItems.plaidItemId, data.plaidItemId))
     .limit(1);
   ```

   **After:**
   ```typescript
   // Check if item already exists for this user and institution
   // This prevents unique constraint violation on (user_id, institution_id)
   const [existingItem] = await db
     .select()
     .from(schema.plaidItems)
     .where(
       and(
         eq(schema.plaidItems.userId, data.userId),
         eq(schema.plaidItems.institutionId, data.institutionId)
       )
     )
     .limit(1);
   ```

3. **Enhanced UPDATE clause to include new `plaidItemId`:**
   ```typescript
   await db
     .update(schema.plaidItems)
     .set({
       plaidItemId: data.plaidItemId,           // ← NEW: Update with new ID
       plaidAccessToken: data.plaidAccessToken,
       plaidInstitutionId: data.plaidInstitutionId,
       isActive: true,
       error: null,
       updatedAt: new Date(),
     })
     .where(eq(schema.plaidItems.id, existingItem.id));
   ```

### How It Works Now

1. User reconnects a bank → Plaid generates new `plaid_item_id`
2. Code checks: `SELECT ... WHERE user_id = ? AND institution_id = ?` → finds existing record
3. Code updates existing record with new `plaid_item_id` and `plaid_access_token`
4. No duplicate record created, no constraint violation ✅

---

## Verification

### Automated Checks
- ✅ **Type Check:** No TypeScript errors
- ✅ **Linter:** No Biome issues
- ✅ **Code Review:** No review comments
- ✅ **Security Scan (CodeQL):** 0 alerts

### Similar Patterns Verified

Checked other use cases for similar unique constraint handling:

1. **✅ `IntegrationCredentialsService.storeCredentials()`**
   - Already checks by `(userId, institutionId)` correctly
   - Uses `findByUserAndInstitution()` before inserting

2. **✅ `ImportPlaidAccountsUseCase`**
   - Only creates `plaidAccountMappings` when creating new accounts
   - Handles unique constraints correctly with cascade deletes

No other issues found.

---

## Testing Recommendations

### Manual Testing Steps

1. **Initial Connection:**
   ```
   1. Navigate to integrations page
   2. Click "Connect with Plaid"
   3. Complete Plaid Link flow
   4. Verify accounts imported successfully
   5. Check database: SELECT * FROM plaid_items WHERE user_id = ?;
   ```

2. **Reconnection Test:**
   ```
   1. Disconnect the bank (UI or database)
   2. Reconnect the same bank via Plaid
   3. Verify no error occurs
   4. Check database: plaid_item_id should be updated
   5. Verify accounts still work
   ```

3. **Multiple Institutions:**
   ```
   1. Connect multiple different banks
   2. Disconnect and reconnect each one
   3. Verify all work independently
   ```

### Expected Behavior

- ✅ First connection: Creates new `plaid_items` record
- ✅ Reconnection: Updates existing record with new `plaid_item_id`
- ✅ Multiple banks: Each gets its own record (one per user+institution)
- ✅ No constraint violations
- ✅ Credentials updated correctly

---

## Database Schema Reference

### plaid_items Table

```sql
CREATE TABLE "plaid_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "institution_id" uuid NOT NULL,
  "plaid_item_id" text NOT NULL,
  "plaid_access_token" text NOT NULL,
  "plaid_institution_id" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "consent_expiration_time" timestamp with time zone,
  "error" jsonb,
  "last_successful_sync" timestamp with time zone,
  "last_balance_sync" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  
  -- Constraints
  CONSTRAINT "plaid_items_plaid_item_id_unique" UNIQUE("plaid_item_id"),
  CONSTRAINT "plaid_items_user_id_institution_id_unique" UNIQUE("user_id","institution_id")
);
```

**Key Points:**
- `plaid_item_id` is unique globally (Plaid's identifier)
- `(user_id, institution_id)` is unique together (one connection per user per bank)
- When reconnecting, Plaid generates a new `plaid_item_id`, but `(user_id, institution_id)` stays the same

---

## Related Files

- **Use Case:** `packages/core/src/use-cases/ExchangePlaidTokenUseCase.ts`
- **Schema:** `packages/core/src/database/schema.ts` (lines 386-425)
- **Migration:** `packages/core/src/database/migrations/0019_closed_bucky.sql`
- **Router:** `apps/backend/src/presentation/routers/plaid.ts`

---

## Security Considerations

- ✅ No security vulnerabilities introduced
- ✅ Credentials still encrypted at rest
- ✅ No sensitive data in logs
- ✅ Follows existing authentication patterns
- ✅ CodeQL scan: 0 alerts

---

## Conclusion

The fix properly handles Plaid reconnection scenarios by checking for existing items using the correct unique constraint keys. This prevents database errors while ensuring each user maintains only one connection per institution, with credentials automatically updated on reconnection.

**Impact:**
- Users can now successfully reconnect their bank accounts
- No duplicate records created
- Existing functionality preserved
- Clean upgrade path (no migration needed)
