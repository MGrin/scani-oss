# Database Migration Rollback Scripts

This directory contains rollback scripts for database migrations. These scripts are designed to be run manually by the database owner and are **not** part of the automated Drizzle migration process.

## Available Rollback Scripts

### rollback_0015.sql
Reverts migration `0015_mark_blockchain_integrations.sql`
- Sets `has_integration = false` for all blockchain institutions
- Restores the state before blockchain integrations were enabled

**Usage:**
```bash
psql $DATABASE_URL -f rollback_0015.sql
```

### rollback_0016.sql
Reverts migration `0016_migrate_wallet_data.sql`
- Removes all entries from `user_wallets` table
- Removes `user_wallet_id` and `migrated` flags from account metadata
- Preserves original `walletAddress` in account metadata

**Usage:**
```bash
psql $DATABASE_URL -f rollback_0016.sql
```

### rollback_0017.sql
Reverts migration `0017_migrate_integration_credentials.sql`
- Removes all `user_integration_credentials` entries with `credentials_type = 'api_key'` and the `useSharedKey` marker
- Cleans up integration credentials created during migration

**Usage:**
```bash
psql $DATABASE_URL -f rollback_0017.sql
```

## Rollback Order

To fully rollback the Phase 2 migration, run scripts in **reverse order**:

```bash
# 1. Remove integration credentials first
psql $DATABASE_URL -f rollback_0017.sql

# 2. Remove user_wallets entries and restore account metadata
psql $DATABASE_URL -f rollback_0016.sql

# 3. Revert hasIntegration flags
psql $DATABASE_URL -f rollback_0015.sql
```

## Important Notes

1. **Manual Execution Only**: These scripts are NOT automatically run by Drizzle. They must be executed manually by a database administrator.

2. **Data Loss Warning**: Rollback scripts will delete data from `user_wallets` and `user_integration_credentials` tables. Ensure you have backups before running.

3. **No Cascade to Original Data**: The original `walletAddress` data in account metadata is preserved during migration and restored during rollback.

4. **Verification Queries**: Each rollback script includes verification queries at the end to confirm the rollback was successful.

5. **Testing**: Always test rollback scripts in a development/staging environment before running in production.

## Testing Rollback Scripts

### In Development Environment

```bash
# Backup your database first
pg_dump $DATABASE_URL > backup_before_rollback.sql

# Run rollback scripts
psql $DATABASE_URL -f rollback_0017.sql
psql $DATABASE_URL -f rollback_0016.sql
psql $DATABASE_URL -f rollback_0015.sql

# Verify results
psql $DATABASE_URL -c "SELECT COUNT(*) FROM user_wallets;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM user_integration_credentials;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM institutions WHERE has_integration = true AND LOWER(name) IN ('ethereum', 'bitcoin network', 'polygon');"
```

### Restore from Backup (if needed)

```bash
psql $DATABASE_URL < backup_before_rollback.sql
```

## Support

For issues or questions about these rollback scripts, please contact the database administrator or refer to the main migration documentation.
