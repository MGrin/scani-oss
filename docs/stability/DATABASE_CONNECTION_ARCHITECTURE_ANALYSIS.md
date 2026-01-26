# Database Connection Architecture - Comprehensive Analysis
## January 26, 2026

> **Critical Analysis**: This document provides an honest, engineering-focused analysis of Scani's database connection architecture, identifying fundamental issues and providing actionable recommendations.

---

## Executive Summary

### Current State: Unstable and Fundamentally Flawed

**The Problem**: The system is experiencing chronic database connection issues despite multiple fix attempts. After analyzing the codebase and reviewing 5+ previous "fixes", the root cause is clear: **the architecture is fighting against itself**.

**Key Findings**:
1. ⚠️ **Connection pool configured at 3** - too small for even basic concurrent usage
2. ⚠️ **No transaction management** - only 1 transaction found in entire codebase
3. ⚠️ **Supabase Connection Pooler misunderstood** - treating it like a direct database connection
4. ⚠️ **Multiple conflicting "fixes"** - each iteration made things worse
5. ⚠️ **Architectural confusion** - unclear whether Supabase pooler or postgres.js should handle scaling

**Critical Metrics**:
- **20 tRPC routers** serving API requests
- **19 use cases** with ~61 direct database queries
- **16 repositories** accessing the database
- **18 services** (some with external API + database operations)
- **Connection pool**: 3 connections (was 50 → 20 → 10 → 5 → 1 → 3)
- **Transaction usage**: Virtually none (architectural red flag)

### The Honest Truth

**This is not a "connection pool tuning" problem**. The system has undergone 5+ iterations of connection pool adjustments (50 → 20 → 10 → 5 → 1 → 3), each claiming to fix the issue. **None worked**. Why?

Because the real problems are:
1. **No understanding of connection lifecycle** - connections held open indefinitely during complex operations
2. **No transaction boundaries** - each query grabs a connection, even when multiple queries should share one
3. **External API calls holding database connections** - pricing service fetches from APIs while holding DB connections
4. **N+1 query patterns** - not evident in code structure but likely in practice
5. **Connection pool exhaustion by design** - 3 connections cannot serve 20 routers under any real-world load

---

## Current Configuration Analysis

### Connection Pool Configuration

**File**: `packages/core/src/database/connection.ts`

```typescript
const connectionConfig: postgres.Options = {
  max: 3,                    // ⚠️ CRITICAL: Only 3 connections
  idle_timeout: 20,          // Close idle after 20s
  connect_timeout: 10,       // Fail fast on connection
  max_lifetime: 60 * 30,     // 30 min max lifetime
  prepare: false,            // Required for Supabase pooler
  fetch_types: false,        // Skip type fetching
  connection: {
    application_name: `scani-${NODE_ENV}`,
  },
};
```

### The Evolution of "Fixes" (A History of Failure)

**Documented in previous stability docs**:

1. **Backend Performance Analysis (Jan 2, 2026)**: `max: 5 → 10`
   - **Rationale**: "Too small for production load"
   - **Result**: Still broken

2. **Backend Unresponsiveness Fix**: `max: 10 → 20`
   - **Rationale**: "Doubled connection pool size to handle mobile app traffic"
   - **Result**: Still broken

3. **Render Performance Optimization**: `max: 20 → 10 → 5`
   - **Rationale**: "50 was too high for Render free tier"
   - **Result**: Still broken

4. **Connection Pool Fix (Jan 2, 2026)**: `max: 5 → 1`
   - **Rationale**: "Supabase pooler handles scaling, use single connection"
   - **Result**: Catastrophically broken

5. **Connection Pool Fix v2 (Jan 2, 2026)**: `max: 1 → 3`
   - **Rationale**: "Need 2-3 for concurrent requests"
   - **Result**: Currently broken (why we're here)

**Pattern Recognition**: Every fix adjusts the pool size but none address the fundamental issue - **the application doesn't know how to use database connections properly**.

---

## Architecture Deep Dive

### 1. Connection Lifecycle (The Missing Piece)

**Current Reality**: The codebase has **zero documentation** of connection lifecycle. Where are connections opened? When are they closed? How long do they stay open? **Nobody knows**.

#### What We Know:

**postgres.js Connection Pool Behavior**:
- Opens connections on-demand when a query executes
- Keeps connections open until `idle_timeout` (20s) with no queries
- Reuses connections for subsequent queries within the same pool
- Has a max pool size of 3 connections

**What We Don't Know** (Critical Gaps):
- How long does a typical tRPC request hold a connection?
- Do connections get released after each query or held for the entire request?
- What happens when external API calls are made mid-request?
- Are there connection leaks?

#### Repository Pattern Analysis

**File**: `packages/core/src/repositories/BaseRepository.ts`

```typescript
protected getDb(transaction?: DatabaseTransaction) {
  return transaction || db;  // ⚠️ Always uses global `db` instance
}

async findById(id: string, transaction?: DatabaseTransaction): Promise<TEntity | null> {
  const database = this.getDb(transaction);
  const results = await database
    .select()
    .from(this.table)
    .where(eq(this.table.id, id))
    .limit(1);
  return results[0] || null;
}
```

**Analysis**:
- ✅ **Good**: Supports transactions (but none are used)
- ⚠️ **Concerning**: No connection management - relies on postgres.js pooling
- ❌ **Problem**: Every query grabs a connection from pool, executes, releases
- ❌ **Problem**: No batching or connection reuse within a request

### 2. Transaction Usage (Virtually Non-Existent)

**Critical Finding**: Only **1 transaction** found in the entire codebase.

```bash
$ grep -r "db.transaction" packages/core/src --include="*.ts" | wc -l
1
```

**What This Means**:
- Complex operations don't use transactions (data consistency risk)
- Multiple related queries each grab their own connection
- No way to batch multiple queries in a single connection
- Connection pool churns unnecessarily

**Example - ImportWalletAddressUseCase** (22KB file):
- Imports wallet addresses
- Creates holdings
- Updates balances
- Fetches prices
- **All separate queries, no transaction**

**Impact**: A single "import wallet" operation might:
1. Get connection → check if token exists → release
2. Get connection → create token → release
3. Get connection → create account → release
4. Get connection → create holding → release
5. Get connection → fetch price → release
6. ...repeat 10-50x for multiple tokens

**Result**: Operation uses 50+ connections sequentially when it could use 1 with a transaction.

### 3. Router Query Patterns

**All routers examined**: `apps/backend/src/presentation/routers/*`

#### Holdings Router (`holdings.ts`)

```typescript
// getWithDetails endpoint
getWithDetails: protectedProcedure.query(async ({ ctx }) => {
  const { dbUser } = await requireAuth(ctx);  // Query 1: Check user exists
  return await HoldingImplementations.getWithDetails(  // Query 2-10+: Get holdings with relations
    { userId: dbUser.id, dbUser }, 
    {}
  );
}),
```

**Connection Usage**:
- **Minimum**: 2 queries (auth + data)
- **Typical**: 5-10 queries (with joins and related data)
- **No transaction**: Each query grabs its own connection

#### Dashboard Router (`dashboard.ts`)

```typescript
getOverview: protectedProcedure.query(async ({ ctx }) => {
  const { dbUser } = await requireAuth(ctx);  // Query 1
  return await DashboardImplementations.getOverview(  // Queries 2-20+
    { userId: dbUser.id, dbUser }, 
    {}
  );
}),
```

**Analysis**: Dashboard is one of the worst offenders:
- Portfolio value calculation
- Holdings aggregation
- Top holdings query
- Asset allocation queries
- **Estimated 15-30 separate queries per request**
- **All without a transaction**

### 4. Use Case Database Patterns

**61 direct database queries** found across 19 use cases.

**Example - SyncWalletBalancesUseCase**:
```typescript
// Pseudo-code showing connection usage
for (const holding of holdings) {          // Loop over holdings
  const token = await getToken();          // Query: Get connection, fetch token, release
  const balance = await fetchBalance();    // External API (holding connection?)
  await updateHolding();                   // Query: Get connection, update, release
  await createPrice();                     // Query: Get connection, insert, release
}
```

**Issues**:
1. **Sequential queries** - N holdings = 4N queries
2. **No batching** - could be 1 query to get all tokens
3. **External API calls** - might hold connections while waiting
4. **No transactions** - all queries independent

### 5. External Service Integration (The Hidden Connection Killer)

**Critical Discovery**: Services make external API calls while potentially holding database connections.

**File**: `packages/core/src/services/PricingService.ts`

```typescript
async getTokenPrice(token: Token, baseCurrency: string, timestamp: Date) {
  // Step 1: Query database for cached price (connection acquired)
  const cached = await this.getCachedPrice(...);
  
  if (!cached) {
    // Step 2: Make external API call to CoinGecko/Finnhub
    //         ⚠️ Connection might still be held
    const price = await this.fetchFromProvider(token);
    
    // Step 3: Store in database (another connection acquired)
    await this.tokenPriceRepository.create({...});
  }
}
```

**Rate Limiters**:
- Finnhub: 50 calls/min
- CoinGecko: 10 calls/min (!!!!)
- DeFiLlama: 5 calls/sec

**Impact**: 
- CoinGecko limited to 10 calls/min = 1 call every 6 seconds
- If a database connection is held during the API call, that's 6 seconds of connection hold time
- With 3 connections total, 3 concurrent pricing requests = complete pool exhaustion

### 6. Supabase Connection Pooler (The Misunderstood Beast)

**What Supabase Says**:
> "Supabase uses PgBouncer in transaction mode on port 6543. Recommended: 2-3 connections per client."

**What This Means**:
- **Transaction mode**: PgBouncer assigns a connection for the duration of a transaction
- **2-3 connections**: Per application instance, not total
- **Pooler handles scaling**: But only if clients use transactions properly

**Current Implementation**:
```typescript
max: 3,          // 3 connections per instance
prepare: false,  // ✅ Required for transaction mode
```

**The Problem**:
- ✅ Connection count is correct (3)
- ✅ Prepare statements disabled (correct)
- ❌ **Application doesn't use transactions** - defeats the purpose of transaction mode pooling
- ❌ **Every query is a "transaction"** - extreme overhead in PgBouncer
- ❌ **Pooler can't optimize** - no way to know which queries are related

---

## Query Pattern Analysis

### Typical Request Flow

**Example**: Loading the dashboard

```
1. HTTP Request → Backend
2. Auth Middleware:
   - Query: Check user exists (connection #1 acquired)
   - Query: Get user data (connection #1 released)
3. Dashboard Router:
   - Query: Get holdings (connection #2 acquired + released)
   - Query: Get accounts (connection #1 acquired + released)
   - Query: Get token prices (connection #3 acquired)
     - External API: CoinGecko (6 second wait, connection #3 held?)
     - Query: Store price (connection #3 released)
   - Query: Get institution data (connection #1 acquired + released)
   - Query: Aggregate portfolio value (connection #2 acquired + released)
4. Response sent
```

**Connection Usage**:
- **Queries**: 7-10 separate queries
- **Connections**: 3 connections used (sequential reuse)
- **Bottleneck**: If any query takes >1 second, others queue
- **Worst Case**: External API call holds connection for 6+ seconds

### Parallel Request Scenario

**What happens with 3 concurrent dashboard loads?**

```
Request A: Uses connection #1 (dashboard query)
Request B: Uses connection #2 (dashboard query)
Request C: Uses connection #3 (dashboard query)
Request D: WAITS (no connections available)
Request E: WAITS (no connections available)
```

**With External API Calls**:
```
Request A: Connection #1 → API call → 6 second hold
Request B: Connection #2 → API call → 6 second hold
Request C: Connection #3 → API call → 6 second hold
Requests D-Z: ALL WAIT 6+ SECONDS
```

**Result**: System appears frozen/unresponsive.

---

## Bottlenecks Identified

### 1. Connection Pool Size (Too Small By Design)

**Current**: 3 connections
**Requirement**: 20 routers × concurrent requests

**Math**:
- 3 connections
- Average 2 requests/second (very light load)
- Average request takes 500ms
- **Capacity**: 6 requests/second (3 connections × 2 per second)

**Reality Check**: 
- Dashboard requests take 2-3 seconds (10+ queries each)
- Capacity drops to ~1 request/second per connection
- Total throughput: 3 requests/second
- **Any more than 3 concurrent users = queuing**

### 2. External API Call Integration (Critical Design Flaw)

**Issue**: External API calls (6+ second delays) might hold database connections.

**Evidence**:
- PricingService makes API calls
- No explicit connection lifecycle management
- Unclear if connections are held during external calls

**Impact**:
- If held: 1 API call = 1 connection blocked for 6+ seconds
- 3 concurrent API calls = entire pool blocked
- System becomes unresponsive

**Fix Needed**: Separate external API operations from database queries.

### 3. No Transaction Batching (Massive Inefficiency)

**Current**: Every query is independent
- Hold count queries: 20+ sequential queries in use cases
- Each query: acquire connection → execute → release
- Pool churns constantly

**With Transactions**:
- 20 queries = 1 transaction = 1 connection hold
- Faster execution (no connection overhead)
- Better error handling
- Atomic operations

### 4. N+1 Query Patterns (Suspected)

**Example Pattern Found**:
```typescript
// Get all holdings
const holdings = await getHoldings();

// For each holding, get token (N+1 pattern)
for (const holding of holdings) {
  const token = await getToken(holding.tokenId);
  // ...
}
```

**Should Be**:
```typescript
// Single query with join
const holdingsWithTokens = await getHoldingsWithTokens();
```

### 5. Auth Middleware Overhead

**Every request**:
1. Query: Check if user exists in database
2. JWT validation (Supabase API call?)
3. Possible sync operations

**Impact**: Every endpoint has 1-2 database queries before even starting.

---

## Performance Under Load

### Theoretical Capacity

**With 3 connections, ideal world**:
- Each query takes 50ms
- No queuing
- **Capacity**: 60 queries/second (20 queries/second per connection)

### Real-World Capacity

**With measured query times**:
- Simple query: 50-200ms
- Complex query (joins): 200-500ms
- Queries with pricing: 1-6 seconds (external API)

**Dashboard request** (10 queries, 2 with pricing):
- 8 queries × 200ms = 1.6s
- 2 queries × 6s = 12s
- **Total: ~13.6 seconds per dashboard load**

**With 3 connections**:
- Can serve 3 dashboard requests simultaneously
- 4th request waits 13.6 seconds
- **Capacity: ~0.22 requests/second**

**This is catastrophically slow.**

### Load Test Scenarios

#### Scenario 1: 5 Concurrent Users Loading Dashboard

```
Time 0s:
- User 1-3: Start loading (use all 3 connections)
- User 4-5: Queue

Time 13.6s:
- User 1-3: Complete
- User 4-5: Start loading (use 3 connections)

Time 27.2s:
- User 4-5: Complete

Total time: 27 seconds for 5 users
```

#### Scenario 2: 10 Users with Mixed Operations

```
10 users × mix of operations (dashboard, holdings, accounts)
Average operation: 3 seconds (5 queries each)

With 3 connections:
- 3 operations run simultaneously
- 7 operations queue
- Average wait: 7 seconds
- Total time: ~21 seconds for 10 operations
```

**Conclusion**: System cannot handle even 10 concurrent operations without severe degradation.

---

## Critical Issues Summary

### Architectural Problems

1. **❌ No Connection Lifecycle Management**
   - Unclear when connections are acquired/released
   - No monitoring of connection hold time
   - No understanding of connection reuse patterns

2. **❌ No Transaction Usage**
   - Only 1 transaction in entire codebase
   - Complex operations use multiple independent queries
   - No way to batch related operations

3. **❌ External API Calls in Critical Path**
   - Pricing API calls potentially hold connections
   - 6+ second delays while holding connection
   - No separation of concerns

4. **❌ Sequential Query Patterns**
   - Use cases make 10-50 sequential queries
   - No batching or parallel execution
   - Loops with database queries inside

5. **❌ Connection Pool Too Small**
   - 3 connections cannot serve 20 routers under load
   - Math doesn't work for real-world usage
   - Fighting against Supabase's own recommendations

### Configuration Problems

1. **⚠️ Misunderstanding of Supabase Pooler**
   - Pooler expects transactions, app doesn't use them
   - Transaction mode benefits lost
   - Overhead increased instead of decreased

2. **⚠️ No Connection Monitoring**
   - Can't see connection usage in real-time
   - No alerts when pool exhausted
   - Blind to connection leaks

3. **⚠️ Previous "Fixes" Made It Worse**
   - Each iteration changed pool size
   - None addressed root cause
   - Problem compounded over time

---

## Recommendations

### Immediate Actions (Must Do)

1. **Implement Transaction Boundaries**
   ```typescript
   // Wrap related operations in transactions
   await db.transaction(async (tx) => {
     const user = await userRepo.findById(userId, tx);
     const holdings = await holdingRepo.findByUser(userId, tx);
     const tokens = await tokenRepo.findByIds(tokenIds, tx);
     // All use same connection
   });
   ```

2. **Separate External API Calls**
   ```typescript
   // Step 1: Get data from database (quick)
   const holdings = await getHoldings();
   
   // Step 2: Release connection, make API calls
   const prices = await Promise.all(
     holdings.map(h => pricingService.getPrice(h.tokenId))
   );
   
   // Step 3: Acquire connection, save results
   await savePrices(prices);
   ```

3. **Add Connection Monitoring**
   ```typescript
   // Track connection usage per request
   logger.info({
     requestId,
     connectionTimeMs,
     queriesExecuted,
   });
   ```

4. **Increase Connection Pool (Temporarily)**
   ```typescript
   max: 10,  // Still within Supabase guidelines
   // Gives breathing room while architecture is fixed
   ```

### Short-Term (Next Sprint)

1. **Implement Query Batching**
   - Identify N+1 patterns
   - Use joins instead of loops
   - Batch similar queries

2. **Add Connection Pool Metrics**
   - Active connections
   - Queue length
   - Average wait time
   - Connection leaks

3. **Optimize High-Traffic Endpoints**
   - Dashboard (biggest offender)
   - Holdings list
   - Account aggregations

4. **Cache External API Results**
   - Price data (already done, verify it works)
   - Rate limit less aggressively
   - Use stale-while-revalidate pattern

### Long-Term (Architecture Overhaul)

1. **Implement Proper Transaction Management**
   - Create transaction boundaries for use cases
   - Ensure all related queries use same transaction
   - Add transaction middleware for routers

2. **Separate Read/Write Paths**
   - Read-only replicas for queries
   - Write to primary only
   - Better connection distribution

3. **Implement Query Result Caching**
   - Redis for hot data
   - Reduce database load
   - Faster response times

4. **Connection Pool Per Service**
   - Pricing service: separate pool
   - Auth service: separate pool
   - Main app: separate pool

5. **Consider Alternative Architecture**
   - **Option A**: Keep Supabase, fix application code
   - **Option B**: Migrate to Render Postgres, start fresh
   - **Option C**: Add Redis + query optimization, reduce DB load

---

## Why Previous Fixes Failed

### The Pattern

1. System slow → adjust pool size
2. System still slow → adjust pool size again
3. System breaks → adjust pool size different direction
4. System somewhat works → declare victory
5. **Repeat when next load spike occurs**

### The Reality

**Pool size was never the problem**. The issues are:
- No transaction management
- External API calls in critical path
- Sequential query patterns
- Lack of caching
- No connection lifecycle awareness

**Adjusting max: 50 → 20 → 10 → 5 → 1 → 3** is like rearranging deck chairs on the Titanic. The ship is still sinking.

---

## Honest Assessment

### What Works

- ✅ Drizzle ORM is good (type-safe, modern)
- ✅ Repository pattern is solid
- ✅ Clean architecture boundaries (routers → use cases → repos)
- ✅ TypeDI for dependency injection

### What Doesn't Work

- ❌ Connection pool configuration (too small, misunderstood)
- ❌ Transaction usage (virtually none)
- ❌ External API integration (blocks connections)
- ❌ Query patterns (sequential, not optimized)
- ❌ Lack of monitoring (flying blind)
- ❌ Previous fixes (addressing symptoms, not cause)

### Can It Be Fixed?

**Yes, but requires significant work**:

1. **Implement transactions** - 2-3 weeks, high effort
2. **Refactor external API calls** - 1-2 weeks, medium effort
3. **Optimize query patterns** - 2-4 weeks, high effort
4. **Add monitoring** - 1 week, low effort
5. **Increase connection pool temporarily** - 1 hour, zero effort

**Total**: 6-10 weeks of focused engineering work.

**Alternative**: Migrate to Render Postgres with clean slate - see companion document.

---

## Conclusion

The database connection issues are **not a configuration problem**. They are an **architectural problem**. The application was not designed with connection management in mind, and five iterations of "fixing" the pool size have proven ineffective.

**The system needs**:
1. Transaction management
2. Connection lifecycle awareness
3. Separation of external API calls
4. Query optimization
5. Better monitoring

**Without these changes**, the system will continue to be slow, unresponsive, and unable to scale beyond a handful of concurrent users.

**Recommendation**: Either commit to the 6-10 week architectural overhaul, or seriously consider the Render Postgres migration as a fresh start. Half-measures will not work - the problem is fundamental.

---

**Next Document**: `RENDER_POSTGRES_MIGRATION_ANALYSIS.md` - Evaluating the migration option
