# Backend Unresponsiveness Fix

## Issue Summary

**Problem**: Backend became unresponsive after 5-10 minutes of mobile app usage with no error logs, memory growth, or CPU spikes.

**Root Cause**: Database connection pool exhaustion due to missing connection pooling configuration.

## Diagnosis

The investigation revealed three main issues:

### 1. Database Connection Pool Exhaustion (CRITICAL)

**Symptoms**:
- Backend stops responding to requests
- No error messages in logs
- No memory or CPU spikes
- Health check endpoints may still work (no DB query)

**Root Cause**:
The postgres.js client was initialized without explicit connection pool configuration, using the default settings:
- Max connections: **10** (default)
- No idle timeout (connections kept open indefinitely)
- No max lifetime (old connections never recycled)
- No connect timeout (hanging connections block forever)

**Why It Failed**:
1. Mobile app makes frequent HTTP requests (via tRPC `httpBatchLink`)
2. Each request needs a database connection
3. With only 10 max connections and no timeouts:
   - Idle connections accumulated and weren't released
   - Slow/hanging queries blocked connections
   - After 10 concurrent requests, new requests would hang waiting for available connections
4. The mobile app's aggressive retry logic (refetchOnReconnect) made the problem worse

### 2. Rate Limiter Memory Growth (MEDIUM)

**Symptoms**:
- Gradual memory growth over time
- More pronounced with high traffic and many unique IPs

**Root Cause**:
- No limit on number of rate limiter buckets tracked
- Each unique IP/user-agent creates a new bucket
- Cleanup only happens every 60 seconds
- In high traffic scenarios, Map could grow unbounded

### 3. WebSocket Service Double Initialization (LOW)

**Symptoms**:
- Multiple heartbeat intervals created
- Potential resource leak

**Root Cause**:
- No guard against multiple `initialize()` calls
- Could create duplicate setInterval handlers

## Solution

### 1. Database Connection Pool Configuration

**Changes Made**:
```typescript
const client = postgres(DATABASE_URL, {
  max: 20,              // Max connections (up from default 10)
  idle_timeout: 30,     // Close idle connections after 30s
  connect_timeout: 10,  // Fail connection after 10s
  max_lifetime: 1800,   // Close connections after 30 min
  // ... other options
});
```

**Configuration via Environment Variables**:
```env
# All optional - defaults shown
DB_MAX_CONNECTIONS=20      # Maximum pool size
DB_IDLE_TIMEOUT=30         # Idle timeout in seconds
DB_CONNECT_TIMEOUT=10      # Connect timeout in seconds
DB_MAX_LIFETIME=1800       # Max lifetime in seconds
```

**Benefits**:
- Doubled connection pool size to handle mobile app traffic
- Idle connections automatically closed after 30 seconds
- Old connections recycled every 30 minutes (prevents connection leaks)
- Fast failure on connection issues (10s timeout)

### 2. Rate Limiter Memory Safety

**Changes Made**:
```typescript
export class RateLimiter {
  private maxBuckets: number;  // New field
  
  constructor(opts: RateLimiterOptions) {
    this.maxBuckets = opts.maxBuckets ?? 10000; // Default 10k
    // ...
  }
  
  tryConsume(req: Request, tokens = 1) {
    // Enforce max buckets limit
    if (this.buckets.size >= this.maxBuckets) {
      const firstKey = this.buckets.keys().next().value;
      if (firstKey) this.buckets.delete(firstKey);
    }
    // ...
  }
}
```

**Benefits**:
- Hard limit of 10,000 buckets prevents unbounded memory growth
- FIFO-style eviction (removes oldest inserted bucket first)
- Protects against memory exhaustion from many unique clients

### 3. WebSocket Service Safeguards

**Changes Made**:
```typescript
initialize() {
  // Prevent multiple initializations
  if (this.heartbeatInterval) {
    wsLogger.warn('Already initialized, skipping duplicate');
    return;
  }
  
  this.heartbeatInterval = setInterval(() => {
    this.cleanupStaleConnections();
  }, 30000);
}
```

**Benefits**:
- Prevents duplicate interval creation
- Guards against edge cases in service lifecycle

## Monitoring & Debugging

### New Health Check Endpoints

**1. Database Health**: `GET /health/db`
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

**2. WebSocket Health**: `GET /health/ws`
```json
{
  "status": "ok",
  "timestamp": "2024-11-18T15:00:00.000Z",
  "websocket": {
    "totalConnections": 5,
    "totalUsers": 3,
    "connectionsByUser": [
      { "userId": "user1", "connectionCount": 2 },
      { "userId": "user2", "connectionCount": 1 },
      { "userId": "user3", "connectionCount": 2 }
    ]
  }
}
```

**3. Cron Health**: `GET /health/cron`
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
    }
    // ... other crons
  }
}
```

### Startup Logs

The backend now logs connection pool configuration at startup:
```
🐘 Connected to PostgreSQL database
  url: postgresql://***@localhost:5432/scani
  environment: development
  poolConfig:
    max: 20
    idleTimeout: 30s
    connectTimeout: 10s
    maxLifetime: 1800s
```

## Testing Recommendations

### 1. Connection Pool Behavior
```bash
# Monitor health endpoint during load testing
watch -n 1 curl http://localhost:3001/health/db

# Simulate concurrent requests
for i in {1..50}; do
  curl http://localhost:3001/health/db &
done
```

### 2. Idle Connection Cleanup
```bash
# Make a request, then wait 30+ seconds
curl http://localhost:3001/health/db
sleep 35
# Check logs for connection cleanup
```

### 3. Rate Limiter Memory
```bash
# Simulate many unique clients
for i in {1..15000}; do
  curl -H "X-Forwarded-For: 192.168.1.$((i % 255))" \
       http://localhost:3001/health
done
# Should not exceed 10k buckets
```

## Production Recommendations

### Database Connection Pool Sizing

The optimal pool size depends on your deployment:

**Formula**: `max_connections = (num_instances × connections_per_instance) + buffer`

**For Scani**:
- 1 backend instance = 20 connections (current setting)
- Add 20% buffer for bursts
- Supabase Free Tier: max 60 concurrent connections
- **Recommendation**: Keep at 20 for single instance, adjust if scaling horizontally

**Signs you need more connections**:
- Health check `/health/db` shows increasing query times
- 503 errors in logs mentioning connections
- Requests timing out under load

**Signs you have too many**:
- Database showing many idle connections
- Memory usage on database server increasing
- Connection pool errors from the database

### Environment Variables for Production

```env
# Production settings (for single backend instance)
DB_MAX_CONNECTIONS=20
DB_IDLE_TIMEOUT=30
DB_CONNECT_TIMEOUT=10
DB_MAX_LIFETIME=1800

# For multiple instances (e.g., 3 backend pods)
# DB_MAX_CONNECTIONS=15  # 3 × 15 = 45 connections + buffer
```

### Monitoring Setup

**Key Metrics to Track**:
1. Database connection count (via `/health/db`)
2. Response times under load
3. Rate limiter bucket count
4. WebSocket connection count (via `/health/ws`)

**Alerting Thresholds**:
- `/health/db` query time > 100ms (warning)
- `/health/db` query time > 500ms (critical)
- `/health/db` status != "ok" (critical)

## Related Files Changed

- `packages/core/src/database/connection.ts` - Connection pool configuration
- `packages/core/src/database/index.ts` - Export connection stats
- `apps/backend/src/index.ts` - Health check endpoints
- `apps/backend/src/presentation/middleware/rate-limit.ts` - Memory limits
- `apps/backend/src/infrastructure/websocket/RealTimeUpdatesService.ts` - Initialization guard
- `apps/backend/.env.example` - Documentation for new env vars

## References

- [postgres.js Connection Options](https://github.com/porsager/postgres#connection)
- [Database Connection Pool Best Practices](https://www.cockroachlabs.com/docs/stable/connection-pooling.html)
- [Node.js EventEmitter Memory Leaks](https://nodejs.org/api/events.html#events_eventemitter_setmaxlisteners_n)
