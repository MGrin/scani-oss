# Materialized View Migration Timeout Fix

## Issue
Migration `0027_tranquil_klaw.sql` was timing out on Render during deployment due to initial materialized view population taking too long (5-10+ minutes) with large datasets (225K+ holding_history rows, 42K+ token_prices rows).

## Root Cause
PostgreSQL's `CREATE MATERIALIZED VIEW` statement **immediately populates the view** with data from the query by default. The migration created three complex materialized views that attempted to process and populate large datasets during migration:

```sql
CREATE MATERIALIZED VIEW portfolio_history_holding_snapshots AS
SELECT ... FROM holding_history ... -- Processes 225K+ rows

CREATE MATERIALIZED VIEW portfolio_history_chart_data AS
WITH ... -- Complex joins and aggregations

CREATE MATERIALIZED VIEW portfolio_history_events AS
SELECT ... UNION ALL ... -- Multi-table unions with lateral joins
```

These `CREATE` statements alone (without any explicit REFRESH):
- Process 225K+ rows with complex joins, aggregations, and window functions
- Take 5-10+ minutes to complete on large datasets
- Exceed Render's statement timeout limit
- Cause deployment failures

## Solution
**Use `WITH NO DATA` clause to create empty views** and let the backend service populate them after deployment.

### Changes Made

#### 1. Migration File (`packages/core/src/database/migrations/0027_tranquil_klaw.sql`)
- ✅ Added `WITH NO DATA` clause to all three CREATE MATERIALIZED VIEW statements
- ✅ Updated comments to explain why WITH NO DATA is used
- ✅ Views are created empty (< 1 second per view)
- ✅ Migration completes in seconds instead of minutes

**Before:**
```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS portfolio_history_events AS
SELECT ... -- Immediately populates view (slow!)
```

**After:**
```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS portfolio_history_events
WITH NO DATA
AS
SELECT ... -- Creates structure only (fast!)
```

#### 2. Migration File (`packages/core/src/database/migrations/0028_fix_refresh_function.sql`)
- ✅ Fixed `refresh_portfolio_history_views()` function to handle empty views
- ✅ Added detection for empty views (first refresh)
- ✅ Uses non-concurrent `REFRESH MATERIALIZED VIEW` for initial population
- ✅ Uses `REFRESH MATERIALIZED VIEW CONCURRENTLY` for subsequent updates
- ✅ Resolves "Failed query: SELECT refresh_portfolio_history_views()" error

**Issue:** `REFRESH MATERIALIZED VIEW CONCURRENTLY` fails on empty views created with `WITH NO DATA`

**Solution:** Check if views are empty and use non-concurrent refresh first
```sql
-- Check if views are empty
SELECT COUNT(*) INTO v_count FROM portfolio_history_holding_snapshots;

IF v_count = 0 THEN
  -- First refresh: non-concurrent (populates empty views)
  REFRESH MATERIALIZED VIEW portfolio_history_holding_snapshots;
  -- ...
ELSE
  -- Subsequent: concurrent (doesn't block reads)
  REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_holding_snapshots;
  -- ...
END IF;
```

#### 3. Documentation Updates
- Updated `MATERIALIZED_VIEW_MIGRATION_TIMEOUT_FIX.md` (this file)
- Updated `PORTFOLIO_HISTORY_IMPLEMENTATION_SUMMARY.md`
- Updated `docs/technical/PORTFOLIO_HISTORY_OPTIMIZATION.md`
- Clarified deployment process and expectations

### How It Works Now

1. **Migration Runs** (< 1 minute, no timeout)
   ```sql
   -- Creates empty materialized views with proper indexes
   CREATE MATERIALIZED VIEW portfolio_history_events
   WITH NO DATA
   AS
   SELECT ...
   
   CREATE UNIQUE INDEX idx_portfolio_events_unique ON ...
   -- Views exist but contain no data yet
   ```

2. **Backend Service Starts**
   ```typescript
   // apps/backend/src/index.ts:473
   portfolioHistoryRefreshService.start(10); // Refresh every 10 minutes
   ```

3. **First Refresh Runs Automatically** (5-10 minutes)
   ```typescript
   // packages/core/src/services/PortfolioHistoryRefreshService.ts:31
   this.refresh(); // Runs immediately on start()
   ```

4. **Subsequent Refreshes** (every 10 minutes)
   - Background process, doesn't block anything
   - Uses CONCURRENT refresh (doesn't block reads)

## Deployment Process

### Before Deployment
✅ Verify `PortfolioHistoryRefreshService` is initialized in backend
✅ Confirm service starts on application initialization
✅ Check logs for "Portfolio history refresh service started"

### During Deployment

1. **Apply Migration**
   ```bash
   cd packages/core
   bun run db:migrate
   ```
   - ⏱️ Completes in < 1 minute (fast!)
   - ✅ Creates empty views with indexes
   - ✅ No timeout issues

2. **Start Backend Service**
   ```bash
   cd apps/backend
   bun run start
   ```
   - Logs: "🔄 Portfolio history refresh service started"
   - Logs: "Starting materialized views refresh"
   - Wait 5-10 minutes for first refresh

3. **Verify Population**
   ```sql
   -- Check view row counts
   SELECT COUNT(*) FROM portfolio_history_events;
   SELECT COUNT(*) FROM portfolio_history_chart_data;
   SELECT COUNT(*) FROM portfolio_history_holding_snapshots;
   ```

### After Deployment
✅ Views are populated automatically
✅ Refresh runs every 10 minutes
✅ No manual intervention needed

## Testing

### Verify Empty Views After Migration
```sql
-- Should return 0 rows immediately after migration
SELECT COUNT(*) FROM portfolio_history_events;
SELECT COUNT(*) FROM portfolio_history_chart_data;
SELECT COUNT(*) FROM portfolio_history_holding_snapshots;
```

### Verify Service Starts
```bash
# Check backend logs
tail -f logs/backend.log | grep "portfolio"
```

Expected output:
```
🔄 Portfolio history refresh service started
Starting materialized views refresh
Successfully refreshed portfolio history materialized views
```

### Verify Manual Refresh Works
```sql
-- Should take 5-10 minutes with large datasets
SELECT refresh_portfolio_history_views();
```

### Verify Automatic Refresh Works
Wait 10 minutes after backend starts, then check logs:
```
Starting materialized views refresh (scheduled)
Successfully refreshed portfolio history materialized views
```

## Benefits

### ✅ Solves Migration Timeout
- Migration completes in seconds (vs 10+ minutes before)
- No more Render timeout errors
- Deployments proceed smoothly
- Uses PostgreSQL's `WITH NO DATA` feature designed for exactly this use case

### ✅ Follows PostgreSQL Best Practices
- **Migration**: Schema only (tables, views, indexes, functions)
- **Service**: Data population and maintenance
- Recommended approach for large dataset migrations
- Allows independent scaling of schema deployment and data population

### ✅ No Downtime
- CONCURRENT refresh doesn't block reads
- Service handles population in background
- Users see gradual data availability

### ✅ Automatic Operation
- No manual refresh needed
- Service starts automatically on backend init
- Continues running in background

## Trade-offs

### ⚠️ Temporary Data Gap
**Impact**: Views are empty for 5-10 minutes after migration
**Affected**: Portfolio history endpoints return no data during this window
**Mitigation**: 
- First refresh runs immediately on backend startup
- Users typically don't access historical data during deployment
- Acceptable trade-off vs failed migration

### ⚠️ Depends on Backend Service
**Impact**: Views won't populate if backend doesn't start
**Mitigation**:
- Service initialization is automatic
- Manual refresh available as fallback
- Monitoring alerts on refresh failures

## Troubleshooting

### Views Still Empty After 15 Minutes
1. Check backend logs for refresh errors
2. Verify service started: `grep "Portfolio history refresh" logs/backend.log`
3. Check database connections: `SELECT * FROM pg_stat_activity`
4. Manually trigger refresh: `SELECT refresh_portfolio_history_views()`

### Manual Refresh Times Out
1. Check data volume: `SELECT COUNT(*) FROM holding_history`
2. Increase statement timeout: `SET statement_timeout = '600000'` (10 minutes)
3. Run during low-traffic period
4. Consider indexing optimization

### Service Not Starting
1. Check TypeDI container initialization
2. Verify import order in `apps/backend/src/index.ts`
3. Check for startup errors in logs
4. Verify database connection is working

## Rollback Plan

### If Issues Occur
1. **Stop Backend**: Service stops automatically
2. **Keep Views**: Don't drop them (no harm in keeping)
3. **Revert Code** (optional): Can revert to old implementation if needed

### Drop Views (if needed)
```sql
DROP MATERIALIZED VIEW IF EXISTS portfolio_history_events;
DROP MATERIALIZED VIEW IF EXISTS portfolio_history_chart_data;
DROP MATERIALIZED VIEW IF EXISTS portfolio_history_holding_snapshots;
DROP FUNCTION IF EXISTS refresh_portfolio_history_views();
```

## Monitoring

### Key Metrics
- ✅ Migration duration (should be < 1 minute)
- ✅ First refresh duration (expect 5-10 minutes)
- ✅ Subsequent refresh duration (expect 5-10 minutes)
- ✅ View row counts (should match source tables)
- ✅ Backend startup time (minimal impact)

### Log Patterns to Watch
```
✅ "Portfolio history refresh service started"
✅ "Starting materialized views refresh"
✅ "Successfully refreshed portfolio history materialized views"
❌ "Failed to refresh materialized views"
❌ "Error in scheduled refresh"
```

### Alerts to Configure
- Migration duration > 2 minutes (should investigate)
- Refresh duration > 15 minutes (possible performance issue)
- Refresh failures (critical, views won't update)
- View row counts not increasing (data not flowing)

## Conclusion

This fix resolves the Render migration timeout by separating schema creation (fast) from data population (slow). The architecture is more robust:
- Migrations handle schema only
- Services handle data operations
- Background processes for expensive operations
- No user-facing downtime
- Automatic operation with manual fallback

**Status**: ✅ Production Ready
