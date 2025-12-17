# Plaid Integration Database Migration Guide

## Issue

The Plaid integration was failing with the following error:

```
Failed query: select "id", "institution_id", "plaid_institution_id", "is_active", "created_at", "updated_at" 
from "institution_plaid_mappings" 
where "institution_plaid_mappings"."plaid_institution_id" = $1 limit $2
params: ins_56,1
```

## Root Cause

The `institution_plaid_mappings`, `plaid_items`, and `plaid_account_mappings` tables were added to the TypeScript schema but the corresponding database migration was never generated or applied.

## Solution

A new migration `0019_closed_bucky.sql` has been created that adds the missing tables:

1. **institution_plaid_mappings** - Maps Scani institutions to Plaid institutions
2. **plaid_items** - Stores Plaid items (connections) per user  
3. **plaid_account_mappings** - Maps Plaid accounts to Scani accounts

## How to Apply the Migration

### Production Environment

**⚠️ IMPORTANT: Do NOT auto-apply this migration. Follow the manual steps below.**

1. **Backup your database** before applying any migration:
   ```bash
   # For PostgreSQL
   pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql
   ```

2. **Review the migration file**:
   ```bash
   cat packages/core/src/database/migrations/0019_closed_bucky.sql
   ```

3. **Apply the migration manually**:
   ```bash
   bun run db:migrate
   ```
   
   Or using psql directly:
   ```bash
   psql $DATABASE_URL < packages/core/src/database/migrations/0019_closed_bucky.sql
   ```

4. **Verify the tables were created**:
   ```sql
   -- Check tables exist
   SELECT table_name 
   FROM information_schema.tables 
   WHERE table_name IN ('institution_plaid_mappings', 'plaid_items', 'plaid_account_mappings');
   
   -- Check indexes were created
   SELECT indexname 
   FROM pg_indexes 
   WHERE tablename IN ('institution_plaid_mappings', 'plaid_items', 'plaid_account_mappings');
   ```

### Development Environment

For local development, you can apply the migration using:

```bash
cd /home/runner/work/scani/scani
bun run db:migrate
```

## Migration Details

The migration creates:

- **3 new tables** with proper foreign keys
- **8 indexes** for optimal query performance
- **5 unique constraints** to enforce data integrity

### Tables Created

#### institution_plaid_mappings
- Links Scani institutions to Plaid institutions
- One-to-one mapping (unique constraints on both sides)
- Cascade delete with parent institution

#### plaid_items
- Stores Plaid connection data per user
- Contains access tokens (should be encrypted in production)
- Tracks sync status and errors
- Unique constraint on (user_id, institution_id)

#### plaid_account_mappings
- Links Plaid accounts to Scani accounts
- One-to-one mapping between Plaid and Scani accounts
- Cascade delete with parent plaid_item

## Testing After Migration

After applying the migration, test the Plaid integration:

1. Navigate to the integrations page
2. Click "Connect with Plaid"
3. Complete the Plaid Link flow
4. Verify accounts are imported successfully

## Rollback (if needed)

If you need to rollback this migration:

```sql
-- Drop tables in correct order (respecting foreign keys)
DROP TABLE IF EXISTS plaid_account_mappings CASCADE;
DROP TABLE IF EXISTS plaid_items CASCADE;
DROP TABLE IF EXISTS institution_plaid_mappings CASCADE;
```

## Security Notes

- The `plaid_access_token` field in `plaid_items` stores sensitive credentials
- Ensure these are encrypted at rest in production environments
- Consider using PostgreSQL's pgcrypto extension or application-level encryption
- Never log or expose these tokens in application logs

## Related Files

- Schema definition: `packages/core/src/database/schema.ts`
- Use case: `packages/core/src/use-cases/ExchangePlaidTokenUseCase.ts`
- Router: `apps/backend/src/presentation/routers/plaid.ts`
- Migration: `packages/core/src/database/migrations/0019_closed_bucky.sql`
