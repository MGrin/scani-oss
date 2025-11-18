# Health Check Endpoints Quick Reference

## Overview

The backend provides several health check endpoints for monitoring system health and debugging issues.

## Endpoints

### 1. General Health Check

**Endpoint**: `GET /health`

**Description**: Basic health check that returns 200 if the server is running.

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2024-11-18T15:00:00.000Z",
  "version": "1.0.0"
}
```

**Use Cases**:
- Load balancer health checks
- Basic uptime monitoring
- Quick server responsiveness test

---

### 2. Database Health Check

**Endpoint**: `GET /health/db`

**Description**: Tests database connectivity and returns connection pool configuration.

**Response (Success)**:
```json
{
  "status": "ok",
  "timestamp": "2024-11-18T15:00:00.000Z",
  "database": {
    "connected": true,
    "queryTime": "5ms",
    "poolConfig": {
      "maxConnections": 20,
      "idleTimeout": "30s",
      "connectTimeout": "10s",
      "maxLifetime": "1800s"
    }
  }
}
```

**Response (Error)**:
```json
{
  "status": "error",
  "message": "Database connection failed",
  "timestamp": "2024-11-18T15:00:00.000Z"
}
```
Status Code: `503 Service Unavailable`

**Metrics**:
- `queryTime`: Time taken to execute a simple query (SELECT 1)
  - < 50ms: Good
  - 50-100ms: Acceptable
  - > 100ms: Warning - database might be overloaded
  - > 500ms: Critical - investigate immediately

**Use Cases**:
- Diagnose database connection issues
- Monitor query performance under load
- Verify connection pool configuration
- Detect database outages

**Monitoring Setup**:
```bash
# Watch database health
watch -n 5 curl -s http://localhost:3001/health/db | jq

# Alert on slow queries
QUERY_TIME=$(curl -s http://localhost:3001/health/db | jq -r '.database.queryTime' | sed 's/ms//')
if [ "$QUERY_TIME" -gt 100 ]; then
  echo "WARNING: Slow database query detected: ${QUERY_TIME}ms"
fi
```

---

### 3. WebSocket Health Check

**Endpoint**: `GET /health/ws`

**Description**: Returns statistics about WebSocket connections.

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2024-11-18T15:00:00.000Z",
  "websocket": {
    "totalConnections": 5,
    "totalUsers": 3,
    "connectionsByUser": [
      {
        "userId": "user-123",
        "connectionCount": 2
      },
      {
        "userId": "user-456",
        "connectionCount": 1
      },
      {
        "userId": "user-789",
        "connectionCount": 2
      }
    ]
  }
}
```

**Metrics**:
- `totalConnections`: Total active WebSocket connections
- `totalUsers`: Number of unique users connected
- `connectionsByUser`: Breakdown per user (useful for debugging)

**Use Cases**:
- Monitor WebSocket connection health
- Detect connection leaks (too many connections per user)
- Verify real-time updates are working
- Debug user-specific connection issues

**Monitoring Setup**:
```bash
# Watch WebSocket stats
watch -n 5 curl -s http://localhost:3001/health/ws | jq

# Alert on too many connections
TOTAL_CONNECTIONS=$(curl -s http://localhost:3001/health/ws | jq -r '.websocket.totalConnections')
if [ "$TOTAL_CONNECTIONS" -gt 100 ]; then
  echo "WARNING: Too many WebSocket connections: $TOTAL_CONNECTIONS"
fi
```

---

### 4. Cron Job Health Check

**Endpoint**: `GET /health/cron`

**Description**: Returns status of scheduled cron jobs.

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2024-11-18T15:00:00.000Z",
  "crons": {
    "pricing-cron": {
      "exists": true,
      "nextRun": "2024-11-18T15:30:00.000Z",
      "isRunning": false,
      "pattern": "0,30 * * * *"
    },
    "wallet-balances-cron": {
      "exists": true,
      "nextRun": "2024-11-18T15:15:00.000Z",
      "isRunning": false,
      "pattern": "*/15 * * * *"
    },
    "daily-portfolio-digest-cron": {
      "exists": true,
      "nextRun": "2024-11-19T00:00:00.000Z",
      "isRunning": false,
      "pattern": "0 0 * * *"
    }
  }
}
```

**Metrics**:
- `exists`: Whether the cron job is registered
- `nextRun`: When the job will run next
- `isRunning`: Whether the job is currently executing
- `pattern`: Cron schedule pattern

**Use Cases**:
- Verify cron jobs are scheduled correctly
- Check when next pricing update will occur
- Debug why scheduled tasks aren't running
- Monitor long-running cron jobs

**Monitoring Setup**:
```bash
# Check if pricing cron is scheduled
curl -s http://localhost:3001/health/cron | jq '.crons["pricing-cron"]'

# Alert if cron job is stuck running
IS_RUNNING=$(curl -s http://localhost:3001/health/cron | jq -r '.crons["pricing-cron"].isRunning')
if [ "$IS_RUNNING" = "true" ]; then
  echo "WARNING: Pricing cron job has been running for a long time"
fi
```

---

## Troubleshooting Guide

### Backend is Unresponsive

1. **Check general health**:
   ```bash
   curl http://localhost:3001/health
   ```
   - If this fails → Server is down or not listening on port 3001

2. **Check database health**:
   ```bash
   curl http://localhost:3001/health/db
   ```
   - If `queryTime` > 500ms → Database is overloaded
   - If status is "error" → Database connection failed
   - Check logs for connection pool exhaustion

3. **Check WebSocket connections**:
   ```bash
   curl http://localhost:3001/health/ws
   ```
   - If `totalConnections` is very high → Potential connection leak
   - Check if any user has excessive connections

### High Query Times

**Symptoms**: `/health/db` shows queryTime > 100ms

**Possible Causes**:
1. Database overloaded (too many concurrent queries)
2. Connection pool exhausted (all connections busy)
3. Network latency to database
4. Database needs optimization (indexes, vacuuming)

**Solutions**:
1. Check active database connections:
   ```sql
   SELECT count(*) FROM pg_stat_activity;
   ```
2. Increase `DB_MAX_CONNECTIONS` if needed
3. Check for slow queries in database logs
4. Verify database resources (CPU, memory, disk I/O)

### Connection Pool Issues

**Symptoms**: Requests hang, 503 errors, high queryTime

**Diagnosis**:
```bash
# Check current pool config
curl -s http://localhost:3001/health/db | jq '.database.poolConfig'
```

**Solutions**:
1. Increase `DB_MAX_CONNECTIONS` (e.g., from 20 to 30)
2. Decrease `DB_IDLE_TIMEOUT` (e.g., from 30s to 15s)
3. Check for slow queries blocking connections
4. Monitor with `/health/db` during peak load

### WebSocket Connection Leaks

**Symptoms**: `totalConnections` keeps growing

**Diagnosis**:
```bash
# Check connections per user
curl -s http://localhost:3001/health/ws | jq '.websocket.connectionsByUser'
```

**Solutions**:
1. Check if clients are properly closing connections
2. Verify stale connection cleanup is working (every 30s)
3. Check logs for disconnection events
4. Restart affected user sessions

---

## Monitoring Dashboard Example

Here's a simple monitoring script that checks all health endpoints:

```bash
#!/bin/bash

# Health monitoring script
echo "=== Scani Backend Health Check ==="
echo ""

# General health
echo "1. General Health:"
curl -s http://localhost:3001/health | jq -r '.status'
echo ""

# Database health
echo "2. Database Health:"
DB_STATUS=$(curl -s http://localhost:3001/health/db)
echo "  Status: $(echo $DB_STATUS | jq -r '.status')"
echo "  Query Time: $(echo $DB_STATUS | jq -r '.database.queryTime // "N/A"')"
echo "  Max Connections: $(echo $DB_STATUS | jq -r '.database.poolConfig.maxConnections // "N/A"')"
echo ""

# WebSocket health
echo "3. WebSocket Health:"
WS_STATUS=$(curl -s http://localhost:3001/health/ws)
echo "  Total Connections: $(echo $WS_STATUS | jq -r '.websocket.totalConnections')"
echo "  Total Users: $(echo $WS_STATUS | jq -r '.websocket.totalUsers')"
echo ""

# Cron health
echo "4. Cron Jobs:"
CRON_STATUS=$(curl -s http://localhost:3001/health/cron)
echo "  Pricing Cron: $(echo $CRON_STATUS | jq -r '.crons["pricing-cron"].exists')"
echo "  Next Run: $(echo $CRON_STATUS | jq -r '.crons["pricing-cron"].nextRun // "N/A"')"
echo ""

echo "=== Health Check Complete ==="
```

Save as `health-check.sh`, make executable with `chmod +x health-check.sh`, and run with `./health-check.sh`.

---

## Integration with Monitoring Tools

### Prometheus

```yaml
scrape_configs:
  - job_name: 'scani-backend'
    metrics_path: '/health/db'
    static_configs:
      - targets: ['localhost:3001']
```

### Grafana Alerts

```yaml
- alert: SlowDatabaseQueries
  expr: scani_db_query_time_ms > 100
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Slow database queries detected"
    description: "Query time is {{ $value }}ms"
```

### Uptime Monitoring (UptimeRobot, etc.)

- URL: `http://your-domain.com/health`
- Check Interval: 5 minutes
- Expected: HTTP 200 with "ok" in response

---

## Related Documentation

- [Backend Unresponsiveness Fix](./backend-unresponsiveness-fix.md)
- [Database Connection Configuration](../../packages/core/src/database/connection.ts)
- [Rate Limiting Configuration](../../apps/backend/src/presentation/middleware/rate-limit.ts)
