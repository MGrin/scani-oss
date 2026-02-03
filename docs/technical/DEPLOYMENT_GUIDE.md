# Deployment Guide: Portfolio History Refresh Fix

## Quick Summary

This PR fixes the portfolio history refresh service failure that was causing deployment issues. The fix ensures that the backend can start successfully and populate materialized views asynchronously in the background.

## What Was Fixed

### The Problem
- Error: `Failed query: SELECT refresh_portfolio_history_views()`
- Root cause: Function tried to query unpopulated materialized views, which PostgreSQL doesn't allow
- Impact: Backend couldn't start, portfolio history features unavailable

### The Solution
1. **SQL Function Fix** (Migration 0029): Check `pg_matviews.ispopulated` instead of querying the view
2. **Service Fix**: Start refresh asynchronously so backend doesn't wait 5-10 minutes to start

## Deployment Steps

### 1. Apply Database Migration

```bash
cd packages/core
bun run db:migrate
```

**Expected Output:**
```
✓ Migration 0029_fix_unpopulated_views.sql applied
```

**Time**: < 1 second

### 2. Deploy Backend

```bash
cd apps/backend
bun run start
```

**Expected Logs (Immediate)**:
```
✓ Starting portfolio history refresh service
✓ 🔄 Portfolio history refresh service started
✓ Starting initial materialized views refresh (this may take 5-10 minutes)
```

**Expected Logs (After 5-10 minutes)**:
```
✓ Initial refresh completed - subsequent refreshes will run every 10 minutes
```

### 3. Verify Success

After deployment, check that:

1. **Backend Starts Immediately** (no 5-10 minute wait)
   ```bash
   # Backend should be accepting requests within seconds
   curl http://localhost:YOUR_PORT/health
   ```

2. **Refresh Runs in Background**
   ```sql
   -- Check if refresh is running (within first 10 minutes)
   SELECT pid, query_start, state 
   FROM pg_stat_activity 
   WHERE query LIKE '%REFRESH MATERIALIZED VIEW%';
   ```

3. **Views Get Populated** (after 5-10 minutes)
   ```sql
   SELECT matviewname, ispopulated 
   FROM pg_matviews 
   WHERE matviewname LIKE 'portfolio_history%';
   
   -- Should show ispopulated = true after initial refresh
   ```

## Timeline

| Event | Time | Status Check |
|-------|------|--------------|
| Migration applied | < 1 sec | ✓ No errors |
| Backend starts | < 10 sec | ✓ Logs show service started |
| Initial refresh starts | Immediately | ✓ Log: "Starting initial refresh" |
| Views being populated | 0-10 min | Check pg_stat_activity |
| Initial refresh completes | 5-10 min | ✓ Log: "Initial refresh completed" |
| Views available for queries | 5-10 min | ✓ SELECT COUNT(*) works |
| Subsequent refreshes | Every 10 min | ✓ Automatic, uses CONCURRENT |

## Rollback Plan

If something goes wrong:

### Option 1: Manual Refresh (Recommended)
```sql
-- Trigger refresh manually (wait 5-10 minutes for completion)
SELECT refresh_portfolio_history_views();
```

### Option 2: Temporary Disable
```typescript
// In apps/backend/src/index.ts, comment out line 473:
// portfolioHistoryRefreshService.start(10);
```

This will disable portfolio history features but allow backend to start.

## Monitoring

### Success Indicators ✅
- Backend starts in < 10 seconds
- No errors in logs
- Log: "🔄 Portfolio history refresh service started"
- After 5-10 min: "Initial refresh completed successfully"
- Query `SELECT COUNT(*) FROM portfolio_history_events` returns results (not errors)

### Failure Indicators ❌
- Backend takes > 30 seconds to start
- Error: "materialized view has not been populated"
- Views still show `ispopulated = false` after 15+ minutes
- Portfolio history endpoints return no data

### Debug Commands

```sql
-- Check view status
SELECT matviewname, ispopulated, 
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||matviewname)) as size
FROM pg_matviews 
WHERE matviewname LIKE 'portfolio_history%';

-- Check if refresh is currently running
SELECT pid, query_start, now() - query_start as duration, state, query
FROM pg_stat_activity 
WHERE query LIKE '%REFRESH MATERIALIZED VIEW%'
   OR query LIKE '%refresh_portfolio_history%';

-- Check recent notices/errors
SELECT * FROM pg_stat_database WHERE datname = current_database();
```

## What Changed in This PR

### Files Modified
1. `packages/core/src/database/migrations/0029_fix_unpopulated_views.sql` - New migration
2. `packages/core/src/database/migrations/meta/0029_snapshot.json` - Migration metadata
3. `packages/core/src/database/migrations/meta/_journal.json` - Migration journal
4. `packages/core/src/services/PortfolioHistoryRefreshService.ts` - Async refresh
5. `packages/core/src/services/PortfolioHistoryService.ts` - Updated comments

### Files Added
1. `docs/stability/PORTFOLIO_HISTORY_REFRESH_FIX.md` - Technical documentation
2. `docs/DEPLOYMENT_GUIDE.md` - This file

## FAQ

### Q: Why does the initial refresh take 5-10 minutes?
**A**: The materialized views process 225K+ rows with complex joins and aggregations. This is expected and only happens once per deployment.

### Q: Will the backend be unavailable during the refresh?
**A**: No! The backend starts immediately. The refresh runs asynchronously in the background.

### Q: What happens if the refresh fails?
**A**: The service will automatically retry on the next scheduled interval (10 minutes). Check logs for error details.

### Q: Can I manually trigger a refresh?
**A**: Yes! Run `SELECT refresh_portfolio_history_views();` in SQL. It will take 5-10 minutes.

### Q: Will this affect existing data?
**A**: No. The fix only changes how we check view status. No data is modified or deleted.

## Support

If you encounter issues:

1. Check the logs for specific error messages
2. Run the debug SQL commands above
3. Review `docs/stability/PORTFOLIO_HISTORY_REFRESH_FIX.md` for detailed troubleshooting
4. If needed, use the rollback plan to temporarily disable the feature

## Related Documentation

- [PORTFOLIO_HISTORY_REFRESH_FIX.md](./stability/PORTFOLIO_HISTORY_REFRESH_FIX.md) - Detailed technical analysis
- [MATERIALIZED_VIEW_MIGRATION_TIMEOUT_FIX.md](./stability/MATERIALIZED_VIEW_MIGRATION_TIMEOUT_FIX.md) - Why views are created WITH NO DATA
- [PORTFOLIO_HISTORY_OPTIMIZATION.md](./technical/PORTFOLIO_HISTORY_OPTIMIZATION.md) - Feature architecture

---

**Status**: ✅ Ready for Production Deployment

**Last Updated**: 2026-01-29
