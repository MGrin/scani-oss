# 🏗️ Scani - Architecture Evolution Roadmap

This document outlines the strategic technical evolution for scaling Scani from a solid MVP to an enterprise-grade platform.

---

## Current Architecture (v1.0)

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (React)                     │
│  ┌──────────────────────────────────────────────────┐  │
│  │ tRPC Client → React Query → Optimistic Updates  │  │
│  │ WebSocket Client → Real-time Sync               │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP + WS
┌──────────────────┴──────────────────────────────────────┐
│              Backend (Bun + Elysia)                      │
│  ┌──────────────────────────────────────────────────┐  │
│  │ tRPC Router → Services → Drizzle ORM            │  │
│  │ WebSocket Server → Broadcast Events             │  │
│  │ Auth Middleware (Supabase JWT)                  │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────┴──────────────────────────────────────┐
│              PostgreSQL Database                         │
│  - User data, holdings, transactions                    │
│  - Token prices (time-series)                           │
│  - No replication, single instance                      │
└─────────────────────────────────────────────────────────┘

External APIs:
├── Finnhub (stock prices)
├── CoinGecko (crypto prices)
├── Google Sheets (private assets)
└── Gemini AI (screenshot parsing)
```

**Strengths:**

- ✅ Simple, easy to understand
- ✅ Fast development iteration
- ✅ Type-safe end-to-end
- ✅ Good for <1000 users

**Limitations:**

- ⚠️ Single point of failure (one server)
- ⚠️ WebSocket state in memory (can't scale horizontally)
- ⚠️ No caching layer
- ⚠️ All services in monolith

---

## Target Architecture (v2.0) - Scalable Production

```
                     ┌─────────────┐
                     │   Cloudflare │
                     │   CDN + WAF  │
                     └──────┬───────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼────────┐  ┌──────▼────────┐  ┌──────▼────────┐
│  Frontend App  │  │  Frontend App │  │  Frontend App │
│  (Static CDN)  │  │  (Static CDN) │  │  (Static CDN) │
└────────────────┘  └───────────────┘  └───────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                   ┌────────▼─────────┐
                   │  Load Balancer   │
                   │  (AWS ALB/NLB)   │
                   └────────┬─────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼────────┐  ┌──────▼────────┐  ┌──────▼────────┐
│  Backend Node  │  │  Backend Node │  │  Backend Node │
│  (Bun Server)  │  │  (Bun Server) │  │  (Bun Server) │
└────────┬───────┘  └───────┬───────┘  └───────┬───────┘
         │                  │                   │
         └──────────────────┼───────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        │              Redis Cluster             │
        │  ┌─────────────────────────────────┐  │
        │  │ WebSocket Session State         │  │
        │  │ Rate Limiting Counters          │  │
        │  │ Price Cache (hot data)          │  │
        │  │ User Session Cache              │  │
        │  └─────────────────────────────────┘  │
        └───────────────────┬───────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        │                   │                   │
┌───────▼────────┐  ┌──────▼────────┐  ┌──────▼────────┐
│  PostgreSQL    │  │  PostgreSQL   │  │  PostgreSQL   │
│  Primary       │  │  Read Replica │  │  Read Replica │
│  (Write Only)  │  │  (Read Only)  │  │  (Read Only)  │
└────────────────┘  └───────────────┘  └───────────────┘
        │
        ├── TimescaleDB Extension (for tokenPrices)
        └── Partitioned Tables (by month)

┌─────────────────────────────────────────────────────────┐
│              Background Job Queue (BullMQ)               │
│  - Price fetching (every 5 min)                         │
│  - Portfolio recalculation (every 15 min)               │
│  - Email notifications (async)                          │
│  - Report generation (async)                            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                   Monitoring Stack                       │
│  - Prometheus (metrics)                                 │
│  - Grafana (dashboards)                                 │
│  - Sentry (error tracking)                              │
│  - Elastic APM (distributed tracing)                    │
└─────────────────────────────────────────────────────────┘
```

---

## Migration Phases

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Enable horizontal scaling

**Tasks:**

1. **Add Redis for Session State**

   ```typescript
   // apps/backend/src/services/cache.ts
   import { Redis } from "ioredis";

   export class CacheService {
     private redis: Redis;

     constructor() {
       this.redis = new Redis(process.env.REDIS_URL);
     }

     async setWebSocketSession(userId: string, sessionData: any) {
       await this.redis.setex(
         `ws:session:${userId}`,
         3600, // 1 hour
         JSON.stringify(sessionData)
       );
     }

     async getWebSocketSession(userId: string) {
       const data = await this.redis.get(`ws:session:${userId}`);
       return data ? JSON.parse(data) : null;
     }
   }
   ```

2. **Distributed Rate Limiting**

   ```typescript
   // apps/backend/src/middleware/rate-limit-redis.ts
   import { RateLimiterRedis } from "rate-limiter-flexible";
   import { redis } from "./cache";

   export const distributedLimiter = new RateLimiterRedis({
     storeClient: redis,
     points: 300,
     duration: 1,
     blockDuration: 60,
   });
   ```

3. **Health Check Endpoint**
   ```typescript
   // apps/backend/src/routers/health.ts
   export const healthRouter = router({
     check: publicProcedure.query(async () => {
       const checks = await Promise.all([
         checkDatabase(),
         checkRedis(),
         checkExternalAPIs(),
       ]);

       return {
         status: checks.every((c) => c.ok) ? "healthy" : "degraded",
         timestamp: new Date(),
         checks: {
           database: checks[0],
           redis: checks[1],
           externalAPIs: checks[2],
         },
       };
     }),
   });
   ```

**Deployment:**

- Deploy Redis cluster (AWS ElastiCache or self-hosted)
- Update backend to use Redis
- Test with 2 backend instances behind load balancer

---

### Phase 2: Database Optimization (Weeks 3-4)

**Goal:** Handle growing data volume and improve query performance

**Tasks:**

1. **Add Read Replicas**

   ```typescript
   // apps/backend/src/db/connection.ts
   import { drizzle } from "drizzle-orm/postgres-js";
   import postgres from "postgres";

   const primary = postgres(process.env.DATABASE_URL);
   const replica = postgres(process.env.DATABASE_REPLICA_URL);

   export const dbPrimary = drizzle(primary);
   export const dbReplica = drizzle(replica);

   // Use in routers:
   // - Reads → dbReplica
   // - Writes → dbPrimary
   ```

2. **Partition TokenPrices Table**

   ```sql
   -- Migration: 0020_partition_token_prices.sql

   -- Convert to partitioned table
   CREATE TABLE token_prices_new (
     LIKE token_prices INCLUDING ALL
   ) PARTITION BY RANGE (timestamp);

   -- Create monthly partitions
   CREATE TABLE token_prices_2025_09 PARTITION OF token_prices_new
     FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');

   CREATE TABLE token_prices_2025_10 PARTITION OF token_prices_new
     FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

   -- ... create partitions for next 12 months

   -- Migrate data
   INSERT INTO token_prices_new SELECT * FROM token_prices;

   -- Swap tables
   ALTER TABLE token_prices RENAME TO token_prices_old;
   ALTER TABLE token_prices_new RENAME TO token_prices;
   ```

3. **Add TimescaleDB for Time-Series**

   ```sql
   -- Enable TimescaleDB extension
   CREATE EXTENSION IF NOT EXISTS timescaledb;

   -- Convert tokenPrices to hypertable
   SELECT create_hypertable('token_prices', 'timestamp',
     chunk_time_interval => INTERVAL '1 month',
     if_not_exists => TRUE
   );

   -- Add compression policy (compress data older than 7 days)
   ALTER TABLE token_prices SET (
     timescaledb.compress,
     timescaledb.compress_orderby = 'timestamp DESC'
   );

   SELECT add_compression_policy('token_prices', INTERVAL '7 days');

   -- Add retention policy (drop data older than 2 years)
   SELECT add_retention_policy('token_prices', INTERVAL '2 years');
   ```

4. **Implement Connection Pooling**
   ```typescript
   // apps/backend/src/db/connection.ts
   const pool = postgres(process.env.DATABASE_URL, {
     max: 20, // max connections
     idle_timeout: 20,
     connect_timeout: 10,
   });
   ```

---

### Phase 3: Async Job Processing (Weeks 5-6)

**Goal:** Move heavy operations off request path

**Tasks:**

1. **Add BullMQ for Job Queue**

   ```typescript
   // apps/backend/src/jobs/queue.ts
   import { Queue, Worker } from "bullmq";
   import { redis } from "../services/cache";

   export const priceUpdateQueue = new Queue("price-updates", {
     connection: redis,
     defaultJobOptions: {
       attempts: 3,
       backoff: {
         type: "exponential",
         delay: 1000,
       },
     },
   });

   export const priceUpdateWorker = new Worker(
     "price-updates",
     async (job) => {
       const { userId } = job.data;
       await portfolioValuationService.updateUserPortfolioPrices(userId);
     },
     { connection: redis, concurrency: 10 }
   );
   ```

2. **Schedule Recurring Jobs**

   ```typescript
   // apps/backend/src/jobs/scheduler.ts
   import { priceUpdateQueue } from "./queue";

   // Update all portfolio prices every 5 minutes
   await priceUpdateQueue.add(
     "update-all-portfolios",
     {},
     {
       repeat: {
         pattern: "*/5 * * * *", // cron: every 5 minutes
       },
     }
   );
   ```

3. **Move Screenshot Processing to Queue**
   ```typescript
   // apps/backend/src/routers/screenshot-parsing.ts
   parseScreenshot: protectedProcedure
     .input(ParseScreenshotSchema)
     .mutation(async ({ input, ctx }) => {
       const userId = getUserId(ctx);

       // Queue the job instead of processing synchronously
       const job = await screenshotQueue.add('parse', {
         userId,
         imageBase64: input.imageBase64,
         accountId: input.accountId,
       });

       return {
         success: true,
         jobId: job.id,
         message: 'Screenshot queued for processing',
       };
     }),
   ```

---

### Phase 4: Caching Layer (Weeks 7-8)

**Goal:** Reduce database load and API calls

**Tasks:**

1. **Price Caching with Stale-While-Revalidate**

   ```typescript
   // apps/backend/src/services/price-cache.ts
   export class PriceCacheService {
     private redis: Redis;
     private readonly CACHE_TTL = 300; // 5 minutes
     private readonly STALE_TTL = 3600; // 1 hour

     async getPrice(tokenId: string, baseCurrency: string) {
       const cacheKey = `price:${tokenId}:${baseCurrency}`;

       // Try to get fresh price from cache
       const cached = await this.redis.get(cacheKey);
       if (cached) {
         return JSON.parse(cached);
       }

       // Try to get stale price while fetching fresh
       const stale = await this.redis.get(`${cacheKey}:stale`);
       if (stale) {
         // Return stale data immediately
         const data = JSON.parse(stale);

         // Trigger background refresh
         this.refreshPriceInBackground(tokenId, baseCurrency);

         return { ...data, isStale: true };
       }

       // No cache, fetch fresh
       return this.fetchAndCachePrice(tokenId, baseCurrency);
     }

     private async fetchAndCachePrice(tokenId: string, baseCurrency: string) {
       const price = await pricingService.getTokenPrice(...);
       const cacheKey = `price:${tokenId}:${baseCurrency}`;

       // Set fresh cache
       await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(price));

       // Set stale cache (longer TTL)
       await this.redis.setex(`${cacheKey}:stale`, this.STALE_TTL, JSON.stringify(price));

       return price;
     }
   }
   ```

2. **User Context Caching**

   ```typescript
   // Cache user base currency, token types, etc.
   async getBaseCurrency(userId: string) {
     const cacheKey = `user:${userId}:baseCurrency`;

     const cached = await redis.get(cacheKey);
     if (cached) return JSON.parse(cached);

     const currency = await db.query...;

     // Cache for 1 hour
     await redis.setex(cacheKey, 3600, JSON.stringify(currency));

     return currency;
   }
   ```

3. **Query Result Caching**
   ```typescript
   // Cache expensive aggregations
   async getPortfolioValue(userId: string) {
     const cacheKey = `portfolio:${userId}:value`;

     // Check cache
     const cached = await redis.get(cacheKey);
     if (cached) return JSON.parse(cached);

     // Calculate
     const value = await this.calculatePortfolioValue(userId);

     // Cache for 5 minutes
     await redis.setex(cacheKey, 300, JSON.stringify(value));

     return value;
   }
   ```

---

### Phase 5: Observability (Weeks 9-10)

**Goal:** Monitor performance and catch issues proactively

**Tasks:**

1. **Add Prometheus Metrics**

   ```typescript
   // apps/backend/src/monitoring/metrics.ts
   import { register, Counter, Histogram, Gauge } from "prom-client";

   export const metrics = {
     httpRequestDuration: new Histogram({
       name: "http_request_duration_seconds",
       help: "Duration of HTTP requests in seconds",
       labelNames: ["method", "route", "status"],
     }),

     priceApiCalls: new Counter({
       name: "price_api_calls_total",
       help: "Total price API calls",
       labelNames: ["provider", "status"],
     }),

     activeWebSockets: new Gauge({
       name: "websocket_connections_active",
       help: "Number of active WebSocket connections",
     }),

     portfolioCalculationDuration: new Histogram({
       name: "portfolio_calculation_duration_seconds",
       help: "Duration of portfolio calculations",
       labelNames: ["user_id"],
     }),
   };

   // Export metrics endpoint
   app.get("/metrics", async () => {
     return register.metrics();
   });
   ```

2. **Add Distributed Tracing**

   ```typescript
   // apps/backend/src/monitoring/tracing.ts
   import { trace } from '@opentelemetry/api';

   const tracer = trace.getTracer('scani-backend');

   // Wrap expensive operations
   async getTokenPrices(tokens, baseCurrency) {
     return tracer.startActiveSpan('getTokenPrices', async (span) => {
       span.setAttribute('tokenCount', tokens.length);
       span.setAttribute('baseCurrency', baseCurrency);

       try {
         const prices = await this.fetchPrices(...);
         span.setStatus({ code: SpanStatusCode.OK });
         return prices;
       } catch (error) {
         span.recordException(error);
         span.setStatus({ code: SpanStatusCode.ERROR });
         throw error;
       } finally {
         span.end();
       }
     });
   }
   ```

3. **Add Error Tracking with Sentry**

   ```typescript
   // apps/backend/src/index.ts
   import * as Sentry from "@sentry/bun";

   Sentry.init({
     dsn: process.env.SENTRY_DSN,
     environment: process.env.NODE_ENV,
     tracesSampleRate: 0.1,
   });

   // Automatically capture errors
   app.onError(({ error }) => {
     Sentry.captureException(error);
   });
   ```

---

## Technology Additions

### Current Stack

- ✅ Bun (runtime)
- ✅ Elysia (HTTP server)
- ✅ tRPC (API)
- ✅ Drizzle ORM
- ✅ PostgreSQL
- ✅ WebSocket

### Add for Scaling

- **Redis** - Caching, session state, pub/sub
- **BullMQ** - Job queue for async tasks
- **TimescaleDB** - Time-series optimization
- **Prometheus** - Metrics collection
- **Grafana** - Metrics visualization
- **Sentry** - Error tracking
- **OpenTelemetry** - Distributed tracing

---

## Cost Projections

### Current Architecture (MVP)

- 1x Server: $50/month (Render/Railway)
- 1x PostgreSQL: $25/month (Supabase/Render)
- **Total: ~$75/month** (handles 100-500 users)

### Scaled Architecture (v2.0)

- 3x Backend Servers: $150/month
- 1x PostgreSQL Primary + 2x Replicas: $200/month
- 1x Redis Cluster: $50/month
- CDN (Cloudflare): $20/month
- Monitoring (Grafana Cloud): $50/month
- **Total: ~$470/month** (handles 10,000+ users)

### Cost Per User

- MVP: $0.15-0.75/user/month
- Scaled: $0.047/user/month
- **67% cost reduction per user at scale**

---

## Performance Benchmarks

### Current (v1.0)

- Dashboard load: 2-5s (with 20 holdings)
- Portfolio calculation: 20-30s (large portfolio)
- Concurrent users: ~100
- Database queries/request: 5-10

### Target (v2.0)

- Dashboard load: <1s (with caching)
- Portfolio calculation: 3-5s (with Redis + job queue)
- Concurrent users: 10,000+
- Database queries/request: 1-3 (with read replicas + caching)

---

## Summary

This architecture evolution provides:

- ✅ **Horizontal scalability** (multiple backend nodes)
- ✅ **High availability** (no single point of failure)
- ✅ **Better performance** (caching, read replicas)
- ✅ **Cost efficiency** (lower per-user cost at scale)
- ✅ **Observability** (monitoring, tracing, alerting)

**Timeline:** 10 weeks from MVP to production-ready scalable architecture
**Investment:** ~$5,000-10,000 in development time + $400/month infrastructure

**ROI:** Supports 100x user growth without architectural changes.
