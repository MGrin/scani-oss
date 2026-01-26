# Database Architecture Fix - Implementation Plan
## January 26, 2026

> **Implementation Roadmap**: Step-by-step plan to fix database connection architecture issues identified in the comprehensive analysis.

---

## Overview

This plan addresses the fundamental architectural issues causing database connection problems:
1. No transaction management
2. External API calls blocking database connections
3. Sequential query patterns
4. No connection lifecycle monitoring
5. Connection pool too small for current architecture

**Goal**: Fix root causes, not symptoms. Each step builds on previous ones.

---

## Phase 1: Foundation & Monitoring

### Step 1.1: Increase Connection Pool (Immediate Relief)
**What**: Temporarily increase connection pool from 3 to 10
**Why**: Provides breathing room while we fix architecture
**Where**: `packages/core/src/database/connection.ts`
**Validation**: System should handle 10 concurrent requests without timeouts

### Step 1.2: Add Connection Lifecycle Monitoring
**What**: Implement connection usage tracking per request
**Why**: Visibility into connection usage patterns
**Components**:
- Track connection acquisition time per request
- Log queries executed per connection
- Identify long-running queries
- Measure connection hold time
**Where**: 
- `packages/core/src/database/connection.ts` - Add monitoring hooks
- `apps/backend/src/index.ts` - Request-level tracking
**Validation**: Logs show connection usage per request

### Step 1.3: Add Health Endpoint Metrics
**What**: Enhance `/health/db` endpoint with detailed metrics
**Why**: Real-time visibility into connection pool state
**Metrics**:
- Active connections count
- Idle connections count
- Queued requests count
- Connection pool exhaustion events
- Average query time
- Slowest queries (last 100)
**Where**: `apps/backend/src/index.ts`
**Validation**: Health endpoint returns all metrics

---

## Phase 2: Transaction Management

### Step 2.1: Create Transaction Wrapper Utility
**What**: Create reusable transaction wrapper for use cases
**Why**: Standardize transaction usage across codebase
**Components**:
- `packages/core/src/database/transaction.ts` - Transaction helper
- Type-safe transaction context
- Automatic rollback on error
- Transaction timeout configuration
**Where**: New file `packages/core/src/database/transaction.ts`
**Validation**: Unit test transaction wrapper behavior

### Step 2.2: Refactor Use Cases to Use Transactions (High Priority)
**What**: Wrap related database operations in transactions
**Why**: Reduce connection pool churn, improve atomicity
**Target Use Cases** (by priority):
1. `ImportWalletAddressUseCase` - Multiple creates/updates
2. `SyncWalletBalancesUseCase` - Batch updates
3. `SyncExchangeBalancesUseCase` - Batch updates
4. `ImportPlaidAccountsUseCase` - Multiple creates
5. `ImportBinanceAccountsUseCase` - Multiple creates
6. `ImportKrakenAccountsUseCase` - Multiple creates
7. `CreateHoldingsWithDependenciesUseCase` - Multiple creates
8. `DeleteHoldingUseCase` - Cascading deletes
**Where**: `packages/core/src/use-cases/*.ts`
**Validation**: Each use case tested, query count reduced

### Step 2.3: Add Transaction Support to Repository Methods
**What**: Ensure all repository methods properly accept transaction parameter
**Why**: Enable transaction usage throughout data layer
**Components**:
- Audit all repository methods
- Ensure transaction parameter passed through
- Add transaction to complex queries with joins
**Where**: `packages/core/src/repositories/*.ts`
**Validation**: All repositories tested with transactions

### Step 2.4: Implement Transaction Middleware for Routers
**What**: Create tRPC middleware to wrap requests in transactions where appropriate
**Why**: Automatic transaction management for mutations
**Components**:
- Create transactional procedure wrapper
- Apply to all mutation endpoints
- Automatic rollback on errors
**Where**: `apps/backend/src/presentation/trpc.ts`
**Validation**: Mutations use transactions automatically

---

## Phase 3: Separate External API Calls

### Step 3.1: Refactor PricingService Architecture
**What**: Separate database operations from external API calls
**Why**: Prevent external delays from holding database connections
**Components**:
- Split `getTokenPrice()` into separate steps:
  1. Query database for cached prices (quick)
  2. Release connection
  3. Make external API calls (slow)
  4. Acquire new connection
  5. Store results (quick)
- Implement request coalescing for duplicate price requests
**Where**: `packages/core/src/services/PricingService.ts`
**Validation**: Price fetches don't hold connections during API calls

### Step 3.2: Implement Background Price Fetching
**What**: Move price fetching to background jobs
**Why**: Remove external API calls from user request path
**Components**:
- Create price fetch queue
- Background worker to process queue
- Serve cached prices to users immediately
- Update prices asynchronously
**Where**: 
- `packages/core/src/services/PricingService.ts`
- New: `apps/backend/src/infrastructure/workers/PriceFetchWorker.ts`
**Validation**: User requests return cached prices instantly

### Step 3.3: Refactor PortfolioValuationService
**What**: Separate valuation calculation from price fetching
**Why**: Calculate portfolio value using cached prices only
**Components**:
- Use cached prices for valuation
- Fall back to last known price if unavailable
- Queue price refresh for next run
- Never block on external APIs
**Where**: `packages/core/src/services/PortfolioValuationService.ts`
**Validation**: Portfolio valuation completes in <1 second

---

## Phase 4: Query Optimization

### Step 4.1: Identify and Fix N+1 Query Patterns
**What**: Find loops with database queries and convert to batch queries
**Why**: Reduce total number of database queries
**Target Areas**:
- Holdings with token lookups
- Accounts with institution lookups
- Transactions with holding/token lookups
**Technique**: Use joins or `findByIds()` batch queries
**Where**: All use cases and services
**Validation**: Query count reduced by 50%+ in affected endpoints

### Step 4.2: Implement Query Result Caching
**What**: Add in-memory caching for frequently accessed data
**Why**: Reduce database load for read-heavy operations
**Caching Strategy**:
- User's base currency (5 minute TTL)
- Token metadata (10 minute TTL)
- Institution types (1 hour TTL)
- Account types (1 hour TTL)
**Where**: 
- New: `packages/core/src/cache/MemoryCache.ts`
- Update services to use cache
**Validation**: Cache hit rate >70% for cached entities

### Step 4.3: Optimize Dashboard Queries
**What**: Reduce query count for dashboard overview
**Why**: Dashboard is highest-traffic endpoint
**Optimizations**:
- Combine multiple queries into single complex query
- Use CTEs (Common Table Expressions) for aggregations
- Pre-calculate common aggregations
- Cache dashboard results (1 minute TTL)
**Where**: 
- `packages/core/src/features/implementations/DashboardImplementations.ts`
- `apps/backend/src/presentation/routers/dashboard.ts`
**Validation**: Dashboard loads in <2 seconds, query count <5

### Step 4.4: Batch Database Operations
**What**: Group similar operations into batch queries
**Why**: Reduce connection churn and improve throughput
**Target Operations**:
- Bulk holding updates
- Bulk price updates
- Batch token lookups
- Batch account lookups
**Where**: All repositories and use cases
**Validation**: Batch operations use 1 query instead of N

---

## Phase 5: Advanced Optimizations

### Step 5.1: Implement Request-Level Connection Pooling
**What**: Track and limit concurrent database operations per request
**Why**: Prevent single request from exhausting pool
**Components**:
- Request context tracks connection usage
- Limit to 2 concurrent queries per request
- Queue additional queries
- Fail fast if queue too long
**Where**: `apps/backend/src/presentation/middleware/connection-limit.ts`
**Validation**: No single request uses >2 connections

### Step 5.2: Add Query Performance Monitoring
**What**: Track slow queries and connection pool metrics
**Why**: Identify performance regressions quickly
**Components**:
- Log all queries >100ms
- Track query execution times
- Identify frequent slow queries
- Alert on connection pool exhaustion
**Where**: `packages/core/src/database/connection.ts`
**Validation**: Slow query dashboard available

### Step 5.3: Implement Read-Only Query Optimization
**What**: Mark read-only queries for potential optimization
**Why**: Enable future read replica support
**Components**:
- Create `readOnlyQuery()` helper
- Use for all SELECT queries
- Track read vs write query ratio
**Where**: All repositories and services
**Validation**: 80%+ queries marked as read-only

### Step 5.4: Add Circuit Breaker for External APIs
**What**: Implement circuit breaker pattern for external API calls
**Why**: Prevent cascade failures when external APIs are slow
**Components**:
- Circuit breaker for each external API
- Fail fast when circuit open
- Automatic recovery testing
- Fallback to cached data
**Where**: 
- `packages/core/src/external-services/pricing/utils.ts`
- All external API integrations
**Validation**: System remains responsive when external API fails

---

## Phase 6: Long-Term Architecture

### Step 6.1: Consider Redis for Hot Data
**What**: Evaluate Redis for frequently accessed data
**Why**: Reduce database load significantly
**Data to Cache**:
- User sessions
- Token prices
- Portfolio valuations
- Dashboard aggregations
**Evaluation Criteria**:
- Cost/benefit analysis
- Operational complexity
- Performance improvement
**Where**: New infrastructure component
**Validation**: POC shows >50% reduction in DB queries

### Step 6.2: Implement Database Read Replicas
**What**: Evaluate read replicas for query scaling
**Why**: Distribute read load across multiple databases
**Requirements**:
- Upgrade Supabase plan or use external replicas
- Update connection pooling for read vs write
- Handle replication lag
**Where**: `packages/core/src/database/connection.ts`
**Validation**: Read queries distributed across replicas

### Step 6.3: Database Schema Optimizations
**What**: Review and optimize database schema
**Why**: Improve query performance at source
**Optimizations**:
- Add missing indexes
- Remove unused indexes
- Denormalize hot paths
- Partition large tables
**Where**: Database schema and migrations
**Validation**: Query execution plans show index usage

---

## Implementation Order

### Week 1-2: Phase 1 (Foundation & Monitoring)
- [ ] Step 1.1: Increase connection pool to 10
- [ ] Step 1.2: Add connection lifecycle monitoring
- [ ] Step 1.3: Enhanced health endpoint metrics

### Week 3-4: Phase 2.1-2.2 (Transaction Management - Part 1)
- [ ] Step 2.1: Create transaction wrapper utility
- [ ] Step 2.2: Refactor top 3 use cases to use transactions

### Week 5-6: Phase 2.2-2.4 (Transaction Management - Part 2)
- [ ] Step 2.2: Complete remaining use case refactoring
- [ ] Step 2.3: Add transaction support to repositories
- [ ] Step 2.4: Transaction middleware for routers

### Week 7-8: Phase 3 (Separate External API Calls)
- [ ] Step 3.1: Refactor PricingService architecture
- [ ] Step 3.2: Background price fetching
- [ ] Step 3.3: Refactor PortfolioValuationService

### Week 9-10: Phase 4 (Query Optimization)
- [ ] Step 4.1: Fix N+1 query patterns
- [ ] Step 4.2: Query result caching
- [ ] Step 4.3: Optimize dashboard queries
- [ ] Step 4.4: Batch database operations

### Week 11-12: Phase 5 (Advanced Optimizations)
- [ ] Step 5.1: Request-level connection pooling
- [ ] Step 5.2: Query performance monitoring
- [ ] Step 5.3: Read-only query optimization
- [ ] Step 5.4: Circuit breaker for external APIs

### Future: Phase 6 (Long-Term Architecture)
- [ ] Step 6.1: Redis evaluation
- [ ] Step 6.2: Read replicas evaluation
- [ ] Step 6.3: Database schema optimizations

---

## Success Metrics

### After Phase 1 (Week 2)
- System handles 10 concurrent requests without timeouts
- Connection usage visible in logs
- Health endpoint shows real-time metrics

### After Phase 2 (Week 6)
- 90%+ of use cases use transactions
- Query count reduced by 30-50%
- Connection pool churn reduced by 60%

### After Phase 3 (Week 8)
- External API calls separated from request path
- Price fetching happens in background
- User requests complete in <2 seconds

### After Phase 4 (Week 10)
- N+1 patterns eliminated
- Query count reduced by 50%+ overall
- Dashboard loads in <2 seconds consistently

### After Phase 5 (Week 12)
- Slow query tracking operational
- Circuit breakers prevent cascade failures
- System resilient to external API failures

### Long-Term Goals
- Support 50+ concurrent users
- Response times <1 second (P95)
- Database query count <5 per request (average)
- Zero connection pool exhaustion events

---

## Validation Strategy

Each step will be validated using:

1. **Unit Tests**: Test new utilities and helpers
2. **Integration Tests**: Test refactored use cases and services
3. **Load Testing**: Verify performance improvements under load
4. **Monitoring**: Track metrics before and after each change
5. **Manual Testing**: Verify user-facing functionality works

---

## Rollback Strategy

Each phase can be independently rolled back:
- Phase 1: Revert connection pool size
- Phase 2: Transactions are opt-in, can disable per use case
- Phase 3: External API separation can be reverted
- Phase 4: Caching can be disabled, queries reverted
- Phase 5: Monitoring and limits can be disabled

---

## Dependencies

- No external services required for Phases 1-5
- Phase 6 (Redis) requires new infrastructure
- All changes backward compatible
- No breaking API changes

---

## Notes

- This plan focuses on fixing root causes, not symptoms
- Each phase builds on previous phases
- All changes are incremental and testable
- Performance improvements should compound
- System should remain functional throughout implementation

---

**Next Step**: Begin Phase 1, Step 1.1 - Increase connection pool
