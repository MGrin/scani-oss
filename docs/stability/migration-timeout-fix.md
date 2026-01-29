# Migration Timeout Fix - Supabase Pooler Configuration

**Date:** January 29, 2026  
**Issue:** Build fails on migrations with ETIMEDOUT error  
**Status:** ✅ Fixed

## Problem

Migrations were failing during Render deployments with the following error:

```
DrizzleQueryError: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
params: 
cause: AggregateError [ETIMEDOUT]
```

## Root Cause Analysis

1. **`drizzle-kit migrate` uses its own connection pool**
   - Uses the `pg` driver internally
   - Doesn't respect the application's optimized database connection settings
   - Creates a new connection pool with default settings

2. **Previous configuration violated "fail fast" principle**
   - `drizzle.config.ts` had connection timeout set to 60s
   - Statement timeout set to 120s
   - These high timeouts masked underlying connection issues

3. **Supabase Transaction Pooler requirements not followed**
   - Requires `prepare: false` (transaction mode doesn't support prepared statements)
   - Requires `fetch_types: false` (faster connection establishment)
   - Recommends `max: 1-3` connections (pooler handles scaling)
   - Requires short `connect_timeout: 10s` (fail fast principle)

## Solution

Created a custom migration script that uses the application's database connection configuration:

### Changes Made

1. **Created `/packages/core/src/database/migrate.ts`**
   - Uses `drizzle-orm/postgres-js/migrator` instead of `drizzle-kit migrate`
   - Configures postgres.js client with Supabase pooler settings:
     ```typescript
     const migrationClient = postgres(DATABASE_URL, {
       max: 1,                  // Single connection - pooler handles scaling
       idle_timeout: 20,        // Close idle connections quickly
       connect_timeout: 10,     // Fail fast if connection issues
       prepare: false,          // Required for transaction pooler
       fetch_types: false,      // Skip type fetching
       onnotice: () => {},      // Suppress notices
     });
     ```

2. **Updated `/packages/core/drizzle.config.ts`**
   - Removed excessive connection timeouts
   - Now only used for schema generation (`drizzle-kit generate`)
   - Added clear documentation about purpose

3. **Updated `/packages/core/package.json`**
   - Changed `db:migrate` from `bun drizzle-kit migrate` to `bun src/database/migrate.ts`
   - Users can still use same command: `bun run db:migrate`

## Technical Details

### Supabase Pooler Configuration

Supabase uses PgBouncer in **transaction mode**, which has specific requirements:

- **Small client pools**: Use 1-3 connections max
  - Large pools (>3) cause connection exhaustion at the pooler
  - The pooler itself handles connection scaling
  - Never increase pool size to "fix" performance issues

- **Required settings**:
  - `prepare: false` - Transaction pooler doesn't support prepared statements
  - `fetch_types: false` - Skip type fetching for faster connections

- **Timeouts**: Keep short to fail fast
  - `connect_timeout: 10` seconds (default)
  - Never add retry logic - fix root cause instead
  - Let queries fail naturally if they take too long

### Migration Script Behavior

The new migration script:

1. Validates `DATABASE_URL` environment variable exists
2. Creates a single postgres.js connection with pooler settings
3. Runs all pending migrations from `/packages/core/src/database/migrations/`
4. Properly closes the connection on success or error
5. Exits with appropriate exit code (0 for success, 1 for failure)

## Usage

### For Developers

No changes needed! Continue using the same commands:

```bash
# Generate new migrations (after schema changes)
cd packages/core
bun run db:generate

# Apply migrations to database
bun run db:migrate
```

### For Deployment (Render)

The migration command remains the same in your deployment scripts:

```bash
cd packages/core && bun run db:migrate
```

Or from the root:

```bash
bun run db:migrate
```

## Benefits

1. **Proper Supabase pooler configuration**
   - Migrations now use the same optimized settings as the application
   - Follows Supabase best practices for transaction pooler

2. **Fail fast principle**
   - Short timeouts (10s) expose issues immediately
   - No masking of underlying connection problems

3. **Consistency**
   - Same connection library (postgres.js) used for both runtime and migrations
   - Reduces surface area for connection-related bugs

4. **Backwards compatible**
   - Same command: `bun run db:migrate`
   - No changes needed to deployment scripts or documentation

## Testing

To verify the fix works:

1. **Local testing**:
   ```bash
   cd packages/core
   export DATABASE_URL="your-supabase-url"
   bun run db:migrate
   ```

2. **Verify connection settings**:
   - Check logs for "Using Supabase pooler-optimized connection settings"
   - Confirm migrations complete in <30 seconds

3. **Monitor production deployments**:
   - Check Render logs for successful migration completion
   - Verify no ETIMEDOUT errors

## Related Issues

- Follows guidelines from custom instructions about Supabase pooler configuration
- Implements "fail fast" principle from architecture guidelines
- Aligns with connection pooling best practices in `/packages/core/src/database/connection.ts`

## References

- [Supabase Connection Pooling](https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler)
- [PgBouncer Transaction Mode](https://www.pgbouncer.org/features.html)
- [postgres.js Documentation](https://github.com/porsager/postgres)
- [Drizzle ORM Migrator](https://orm.drizzle.team/docs/migrations)
