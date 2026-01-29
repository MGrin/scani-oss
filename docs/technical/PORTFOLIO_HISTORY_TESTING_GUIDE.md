# Portfolio History Optimization - Testing Guide

## Overview
This guide provides step-by-step instructions for testing the portfolio history performance optimization that uses PostgreSQL materialized views.

## Prerequisites

1. **Database Access**: Ensure you have access to the Supabase database
2. **Backend Running**: The backend service must be running
3. **Data Available**: Some holdings and token price data should exist in the database

## Testing Steps

### 1. Apply Database Migration

First, apply the migration that creates the materialized views:

```bash
cd packages/core
bun run db:migrate
```

**Expected Output**:
- Migration should complete successfully
- No errors should be reported

**Verification**:
```sql
-- Check that materialized views were created
SELECT schemaname, matviewname, hasindexes 
FROM pg_matviews 
WHERE schemaname = 'public';

-- Expected: 3 views
-- - portfolio_history_holding_snapshots
-- - portfolio_history_chart_data  
-- - portfolio_history_events
```

### 2. Verify Initial Data Population

Check that the views contain data:

```sql
-- Check event count
SELECT COUNT(*) FROM portfolio_history_events;

-- Check chart data count
SELECT COUNT(*) FROM portfolio_history_chart_data;

-- Check holding snapshots count
SELECT COUNT(*) FROM portfolio_history_holding_snapshots;
```

**Expected**: Each view should have data (non-zero counts)

### 3. Test Backend Startup

Start the backend and check logs:

```bash
cd apps/backend
bun dev
```

**Expected Logs**:
```
✅ Integration registry initialized
🔄 Portfolio history refresh service started
🎉 Scani Backend Server started successfully
```

**Verification**:
- No errors during startup
- Refresh service initializes successfully
- Backend listens on the configured port

### 4. Test Portfolio History Events Endpoint

#### Via tRPC (Frontend)

If you have the frontend running, navigate to the Portfolio History page and check:
- Events list loads without errors
- Events display correctly with timestamp, type, token info, balance, price, value
- Pagination works (load more events)
- Date range filtering works

#### Via API Testing Tool (Postman/Insomnia)

```http
POST http://localhost:3001/trpc/portfolioHistory.getEvents
Content-Type: application/json
Authorization: Bearer <your-token>

{
  "limit": 20,
  "offset": 0,
  "startDate": "2024-01-01T00:00:00Z",
  "endDate": "2024-12-31T23:59:59Z"
}
```

**Expected Response**:
```json
{
  "events": [
    {
      "timestamp": "2024-01-15T10:30:00Z",
      "eventType": "holding_update",
      "holdingId": "uuid",
      "tokenId": "uuid",
      "tokenSymbol": "BTC",
      "tokenName": "Bitcoin",
      "balance": "0.5",
      "price": "50000",
      "value": "25000",
      "baseCurrencySymbol": "USD"
    },
    // ... more events
  ],
  "total": 150,
  "hasMore": true
}
```

**Validation Checklist**:
- [ ] Response returns quickly (< 500ms)
- [ ] Events are sorted by timestamp descending (newest first)
- [ ] All required fields are present
- [ ] `total` reflects actual event count
- [ ] `hasMore` is correct based on offset+limit vs total
- [ ] Pagination works (change offset, get different events)

### 5. Test Portfolio History Chart Endpoint

#### Via tRPC (Frontend)

If you have the frontend running:
- Navigate to Portfolio History page
- Check that the chart renders correctly
- Verify chart shows portfolio value over time
- Check that chart is responsive and smooth

#### Via API Testing Tool

```http
POST http://localhost:3001/trpc/portfolioHistory.getChart
Content-Type: application/json
Authorization: Bearer <your-token>

{
  "startDate": "2024-01-01T00:00:00Z",
  "endDate": "2024-12-31T23:59:59Z",
  "maxPoints": 500
}
```

**Expected Response**:
```json
[
  {
    "timestamp": "2024-01-01T00:00:00Z",
    "totalValue": "100000.50",
    "holdingsCount": 25
  },
  {
    "timestamp": "2024-01-02T00:00:00Z",
    "totalValue": "102500.75",
    "holdingsCount": 26
  },
  // ... more data points
]
```

**Validation Checklist**:
- [ ] Response returns quickly (< 1 second)
- [ ] Data points are sorted by timestamp ascending (oldest first)
- [ ] Number of data points ≤ maxPoints
- [ ] `totalValue` is a string representation of decimal
- [ ] `holdingsCount` is accurate
- [ ] Chart displays correctly on frontend

### 6. Test Manual Refresh via Service Method

Cron jobs will call the service method directly, not via HTTP endpoint.

Test by invoking the service method in a test script or cron job:

```typescript
// Example cron job code
import { Container } from 'typedi';
import { PortfolioHistoryService } from '@scani/core/services';

const portfolioHistoryService = Container.get(PortfolioHistoryService);
await portfolioHistoryService.refreshMaterializedViews();
```

**Verification**:
- Check backend logs for refresh completion message
- Verify refresh doesn't cause errors
- Query views again to ensure data is still accessible

### 7. Performance Testing

#### Before/After Comparison

If possible, compare performance before and after the optimization:

**Metrics to Compare**:
1. **Response Time**: Time to fetch events/chart data
2. **Memory Usage**: Backend memory consumption during requests
3. **CPU Usage**: Backend CPU usage during requests
4. **Concurrent Users**: Number of users who can query simultaneously

#### Load Testing (Optional)

Use a tool like Apache Bench or k6 to simulate load:

```bash
# Test events endpoint
ab -n 100 -c 10 -H "Authorization: Bearer <token>" \
  http://localhost:3001/trpc/portfolioHistory.getEvents

# Test chart endpoint  
ab -n 100 -c 10 -H "Authorization: Bearer <token>" \
  http://localhost:3001/trpc/portfolioHistory.getChart
```

**Expected Results**:
- 95th percentile response time < 1 second
- No errors or timeouts
- Memory usage stays stable
- CPU usage stays reasonable (< 50%)

### 8. Verify Background Refresh

Check that the background refresh service works:

1. **Wait for automatic refresh** (default: 10 minutes)
2. **Check logs** for refresh messages:
   ```
   Starting materialized views refresh
   Completed materialized views refresh (durationMs: 2500)
   ```
3. **Add new data** (create a holding, update price)
4. **Wait for next refresh**
5. **Query endpoints** to verify new data appears

**Validation**:
- [ ] Automatic refresh runs on schedule
- [ ] Refresh completes without errors
- [ ] New data appears after refresh
- [ ] No concurrent refresh attempts (check logs)

### 9. Error Handling Testing

Test edge cases and error scenarios:

#### Empty Result Set
```http
POST http://localhost:3001/trpc/portfolioHistory.getEvents
Content-Type: application/json
Authorization: Bearer <token>

{
  "limit": 20,
  "offset": 0,
  "startDate": "1990-01-01T00:00:00Z",
  "endDate": "1990-12-31T23:59:59Z"
}
```

**Expected**: Empty events array, total=0, hasMore=false

#### Invalid Date Range
```http
POST http://localhost:3001/trpc/portfolioHistory.getChart
Content-Type: application/json
Authorization: Bearer <token>

{
  "startDate": "2024-12-31T00:00:00Z",
  "endDate": "2024-01-01T00:00:00Z",
  "maxPoints": 500
}
```

**Expected**: Empty result or appropriate error

#### Large Offset
```http
POST http://localhost:3001/trpc/portfolioHistory.getEvents
Content-Type: application/json
Authorization: Bearer <token>

{
  "limit": 20,
  "offset": 999999,
  "startDate": "2024-01-01T00:00:00Z",
  "endDate": "2024-12-31T23:59:59Z"
}
```

**Expected**: Empty events array, hasMore=false

### 10. Database Performance Monitoring

Monitor database query performance:

```sql
-- Check view sizes
SELECT 
  schemaname,
  matviewname,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||matviewname)) AS size
FROM pg_matviews 
WHERE schemaname = 'public';

-- Check index usage
SELECT 
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename LIKE 'portfolio_history%'
ORDER BY idx_scan DESC;
```

**Expected**:
- View sizes should be reasonable (< 100MB each for current data)
- Indexes should show usage (idx_scan > 0 after queries)

### 11. Rollback Testing (Optional)

Test the rollback procedure to ensure we can revert if needed:

1. **Document current state** (response times, view data counts)
2. **Stop the backend**
3. **Revert the code changes** (git revert)
4. **Restart the backend**
5. **Verify endpoints still work** (using old implementation)
6. **Re-apply changes** if everything works
7. **Restart backend**

## Success Criteria

The optimization is successful if:

- [x] All linting and type checks pass
- [ ] Database migration applies without errors
- [ ] Materialized views are created and populated
- [ ] Backend starts successfully with refresh service
- [ ] Events endpoint returns correct data in < 500ms
- [ ] Chart endpoint returns correct data in < 1 second
- [ ] Manual refresh works without errors
- [ ] Background refresh runs on schedule
- [ ] Memory usage drops significantly (> 50% reduction)
- [ ] CPU usage drops significantly (> 50% reduction)
- [ ] No regressions in functionality
- [ ] Render metrics show improvement (no more restarts)

## Troubleshooting

### Migration Fails

**Symptoms**: Error during `bun run db:migrate`

**Solutions**:
1. Check database connection string
2. Verify database user has CREATE VIEW permissions
3. Check for existing views with same names (drop them first)
4. Review migration SQL syntax

### Views are Empty

**Symptoms**: Views exist but contain no data

**Solutions**:
1. Check source tables have data (`holding_history`, `token_prices`)
2. Manually run REFRESH MATERIALIZED VIEW commands
3. Check for errors in database logs
4. Verify user_id exists in users table

### Slow Queries

**Symptoms**: Queries still taking > 1 second

**Solutions**:
1. Run ANALYZE on views to update statistics
2. Check that indexes were created (query pg_indexes)
3. Verify CONCURRENTLY was used for index creation
4. Check query plans with EXPLAIN ANALYZE

### Refresh Fails

**Symptoms**: Background refresh logs errors

**Solutions**:
1. Check database connection is still active
2. Verify database user has REFRESH MATERIALIZED VIEW permissions
3. Check for lock contention (long-running queries)
4. Review error message in logs for specifics

### Memory Still High

**Symptoms**: Backend memory usage not improving

**Solutions**:
1. Verify new code is actually deployed
2. Check that old service instance was stopped
3. Monitor different endpoint (ensure testing correct one)
4. Review application logs for errors or fallbacks

## Next Steps After Testing

Once testing is complete and successful:

1. **Deploy to staging** environment first
2. **Monitor for 24-48 hours** in staging
3. **Collect metrics** and validate improvements
4. **Deploy to production** with monitoring
5. **Set up alerts** for refresh failures
6. **Document lessons learned**
7. **Plan future optimizations** based on metrics

## Support

If you encounter issues during testing:
1. Check the comprehensive documentation at `/docs/technical/PORTFOLIO_HISTORY_OPTIMIZATION.md`
2. Review database and application logs
3. Verify all prerequisites are met
4. Contact the development team with specific error messages
