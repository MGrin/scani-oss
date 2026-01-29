# Quick Reference: Materialized View Migration Fix

## Problem
Migration `0027_tranquil_klaw.sql` times out on Render (10+ minutes with 225K+ rows)

## Solution
Removed initial REFRESH statements from migration. Views are created empty and populated automatically by backend service on startup.

## What Changed

### Migration File
```diff
- REFRESH MATERIALIZED VIEW portfolio_history_holding_snapshots;
- REFRESH MATERIALIZED VIEW portfolio_history_chart_data;
- REFRESH MATERIALIZED VIEW portfolio_history_events;
+ -- NOTE: Initial population removed to prevent migration timeout on Render
+ -- Views will be populated automatically on backend startup
```

## Deployment Commands

```bash
# 1. Apply migration (fast, < 1 minute)
cd packages/core
bun run db:migrate

# 2. Start backend (populates views automatically)
cd apps/backend
bun run start

# 3. Check logs (wait 5-10 minutes)
tail -f logs/backend.log | grep "portfolio"
```

## Expected Logs
```
✅ 🔄 Portfolio history refresh service started
✅ Starting materialized views refresh
✅ Successfully refreshed portfolio history materialized views (in ~5-10 minutes)
```

## Verification

```sql
-- Before backend starts (should be 0)
SELECT COUNT(*) FROM portfolio_history_events;

-- After first refresh (should be populated)
SELECT COUNT(*) FROM portfolio_history_events;
SELECT COUNT(*) FROM portfolio_history_chart_data;
SELECT COUNT(*) FROM portfolio_history_holding_snapshots;
```

## Manual Refresh (if needed)

```sql
SELECT refresh_portfolio_history_views();
-- Takes 5-10 minutes with large datasets
```

## Key Points

✅ Migration completes in < 1 minute (no timeout)
✅ Views populated automatically on backend startup
✅ Refresh runs every 10 minutes in background
⚠️ Views empty for 5-10 minutes after migration
⚠️ Portfolio history endpoints return no data during this window

## Troubleshooting

### Views still empty after 15 minutes?
```bash
# Check logs
grep "refresh" logs/backend.log

# Check service status
SELECT * FROM pg_stat_activity WHERE query LIKE '%portfolio_history%';

# Manual refresh
SELECT refresh_portfolio_history_views();
```

### Migration still timing out?
- Verify REFRESH statements are removed from migration file
- Check migration file line count: should be 242 lines
- Verify no REFRESH commands at end of file

## Documentation
- Full guide: `/docs/stability/MATERIALIZED_VIEW_MIGRATION_TIMEOUT_FIX.md`
- Deployment: `/PORTFOLIO_HISTORY_IMPLEMENTATION_SUMMARY.md`
- Technical: `/docs/technical/PORTFOLIO_HISTORY_OPTIMIZATION.md`
