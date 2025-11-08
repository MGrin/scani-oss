# Phase 2 Migration: User Wallets and Integration Credentials

This directory contains the Phase 2 migration scripts that populate `user_wallets` and `user_integration_credentials` tables from existing account metadata.

## Overview

Phase 2 consists of three migration scripts that work together to migrate existing wallet data into the new normalized structure:

1. **0015_mark_blockchain_integrations.sql** - Marks blockchain institutions as supporting integrations
2. **0016_migrate_wallet_data.sql** - Migrates wallet addresses from account metadata to user_wallets table
3. **0017_migrate_integration_credentials.sql** - Creates integration credentials for blockchain users

## Prerequisites

- Phase 1 (Issue #95) must be completed
- Migrations 0013 and 0014 must be applied (creates user_wallets and user_integration_credentials tables)
- Database backup is strongly recommended before running these migrations

## Migration Scripts

### 0015_mark_blockchain_integrations.sql

**Purpose:** Updates the `has_integration` flag for all blockchain institutions

**What it does:**
- Sets `has_integration = true` for 43 specific blockchain institutions by their UUIDs
- Targets exact institutions that support wallet integrations
- Uses precise institution IDs for reliability

**Impact:**
- Updates exactly 43 institution records
- No data loss - only sets a boolean flag
- Enables integration support for blockchain institutions

### 0016_migrate_wallet_data.sql

**Purpose:** Migrates wallet addresses from account metadata to user_wallets table

**What it does:**
1. Queries all blockchain institutions (crypto_wallet type)
2. Finds accounts with `metadata.walletAddress`
3. Creates ONE `user_wallets` entry per unique (user_id, wallet_address) combination
4. Populates `institution_ids` JSONB array with all chains for that wallet
5. Updates account metadata with `user_wallet_id` reference
6. Marks accounts as migrated with `metadata.migrated = true`

**Important:**
- Original `walletAddress` in account metadata is **preserved** for rollback
- Creates unique wallet entries (same address across multiple chains = one wallet)
- Includes progress logging with NOTICE messages

**Expected outcome:**
- New entries in `user_wallets` table (one per unique wallet address per user)
- Account metadata updated with `user_wallet_id` and `migrated` flags
- Original wallet addresses remain in metadata for safety

### 0017_migrate_integration_credentials.sql

**Purpose:** Creates integration credentials for users with blockchain wallets

**What it does:**
1. Finds all blockchain institutions with `has_integration = true`
2. For each institution, identifies users who have wallets on that chain
3. Creates `user_integration_credentials` entry for each user+institution pair
4. Sets `credentials_type = 'api_key'`
5. Stores marker: `{"useSharedKey": true, "encrypted": false}`

**⚠️ Important Security Note:**
The credentials stored contain an **unencrypted marker** for development/testing. In production:
- These should be properly encrypted using `IntegrationCredentialsService`
- The marker `{"useSharedKey": true}` should be encrypted before use
- A post-migration script should be created to encrypt these credentials

**Expected outcome:**
- New entries in `user_integration_credentials` table
- One credential entry per (user, blockchain institution) combination
- Credentials marked with `credentials_type = 'api_key'`

## Running the Migrations

### Automatic (via Drizzle)

These migrations are part of the Drizzle migration sequence and will be applied automatically:

```bash
cd packages/core
bun db:migrate
```

Or from the project root:

```bash
bun run db:migrate
```

### Manual Verification (Optional)

Before migration:

```sql
-- Count accounts with wallet addresses
SELECT COUNT(*) as accounts_with_wallets
FROM accounts 
WHERE metadata->>'walletAddress' IS NOT NULL 
  AND metadata->>'walletAddress' != '';

-- Count unique wallet addresses per user
SELECT COUNT(DISTINCT (user_id, metadata->>'walletAddress'))
FROM accounts 
WHERE metadata->>'walletAddress' IS NOT NULL;
```

After migration:

```sql
-- Verify user_wallets entries
SELECT COUNT(*) as user_wallets_count FROM user_wallets;

-- Verify integration credentials
SELECT COUNT(*) as credentials_count 
FROM user_integration_credentials 
WHERE credentials_type = 'api_key';

-- Check blockchain institutions with integration
SELECT COUNT(*) as institutions_with_integration
FROM institutions 
WHERE has_integration = true;

-- Verify migrated accounts
SELECT COUNT(*) as migrated_accounts
FROM accounts 
WHERE metadata->>'migrated' = 'true';
```

## Rollback

Rollback scripts are available in `rollback-scripts/` directory. See [rollback-scripts/README.md](rollback-scripts/README.md) for details.

**Quick rollback (in reverse order):**

```bash
# 1. Remove integration credentials
psql $DATABASE_URL -f rollback-scripts/rollback_0017.sql

# 2. Remove user_wallets and restore account metadata
psql $DATABASE_URL -f rollback-scripts/rollback_0016.sql

# 3. Revert hasIntegration flags
psql $DATABASE_URL -f rollback-scripts/rollback_0015.sql
```

## Expected Results

After successful migration:

✅ All blockchain institutions marked with `hasIntegration = true` (47 institutions)
✅ All wallet addresses migrated to `user_wallets` table (unique per user)
✅ Credentials created for all users with blockchain wallets
✅ Account metadata updated with references and migration flags
✅ Original `walletAddress` preserved in account metadata (for rollback)
✅ No data loss

## Testing Checklist

### Before Migration

- [ ] Backup database
- [ ] Count existing accounts with wallet addresses
- [ ] Note sample user IDs and wallet addresses for verification
- [ ] Verify Phase 1 migrations (0013, 0014) are applied

### After Migration

- [ ] Verify `user_wallets` count matches unique (user, address) combinations
- [ ] Check `institution_ids` arrays are populated correctly
- [ ] Verify `user_integration_credentials` has entries for each user+blockchain
- [ ] Confirm credentials contain `{"useSharedKey": true}` marker
- [ ] Check institutions have `hasIntegration = true`
- [ ] Verify account metadata has `user_wallet_id` and `migrated` flags
- [ ] Confirm original `walletAddress` is still in account metadata

### Rollback Test (in staging)

- [ ] Run rollback scripts in reverse order
- [ ] Verify all migrated data is removed
- [ ] Confirm account metadata is restored to original state
- [ ] Check no orphaned records remain

## Troubleshooting

### Migration fails with "relation does not exist"

**Cause:** Phase 1 migrations not applied

**Solution:**
```bash
cd packages/core
bun db:migrate  # Apply all pending migrations
```

### Duplicate key violation on user_wallets

**Cause:** Migration already partially run

**Solution:**
1. Check existing data: `SELECT * FROM user_wallets LIMIT 5;`
2. Either complete the migration or rollback and retry
3. The migration uses `ON CONFLICT` handling, so re-running should be safe

### No institutions marked with hasIntegration

**Cause:** Institution names don't match (case sensitivity or typo)

**Solution:**
1. Check institution names: `SELECT name FROM institutions WHERE type_id = (SELECT id FROM institution_types WHERE code = 'crypto_wallet');`
2. Migration uses `LOWER()` for case-insensitive matching
3. Verify blockchain institution names in database match migration script

### Credentials not encrypted properly

**Expected:** This is by design for Phase 2

**Solution:**
- Phase 2 creates credentials with marker `{"useSharedKey": true, "encrypted": false}`
- A separate encryption script will be needed to properly encrypt these
- For development/testing, the unencrypted marker is acceptable

## Post-Migration Tasks

1. **Encryption of credentials** (production only)
   - Create a script using `IntegrationCredentialsService` to properly encrypt the marker
   - Update all `user_integration_credentials` with encrypted data
   - Remove the `"encrypted": false` flag

2. **Verification**
   - Run manual verification queries (see above)
   - Check application functionality with migrated data
   - Verify wallet management features work correctly

3. **Cleanup** (optional, after successful migration)
   - Consider removing `walletAddress` from account metadata (only after thorough testing)
   - Document any issues or edge cases encountered

## Support

For issues or questions:
- Check this documentation first
- Review rollback scripts for undo procedures
- Refer to Phase 1 documentation for table structure details
- Contact the database administrator for production migrations

## Related Documentation

- Phase 1 Migration: `0013_foamy_vapor.sql` and `0014_cooing_shooting_star.sql`
- Rollback Scripts: [rollback-scripts/README.md](rollback-scripts/README.md)
- Database Schema: `packages/core/src/database/schema.ts`
- Integration Credentials Service: `packages/core/src/services/IntegrationCredentialsService.ts`
