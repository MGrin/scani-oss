# Comprehensive Code Review - Scani Project

**Date**: 2025-10-09  
**Reviewer**: AI Assistant  
**Scope**: Full project review focusing on data handling, caching, pricing, and stability

---

## Executive Summary

This review examined the Scani personal finance management application, focusing on frontend data handling (caching, optimistic updates) and backend data flows (pricing, transactions, database queries). While the codebase shows good architecture and recent fixes, several **critical** and **high-priority** issues were identified that could impact reliability, performance, and user experience.

### Priority Issues Found
- **🔴 CRITICAL**: 3 issues
- **🟠 HIGH**: 5 issues  
- **🟡 MEDIUM**: 7 issues
- **🟢 LOW**: 4 issues

---

## 🔴 CRITICAL ISSUES

### 1. Race Conditions in Cache Invalidation (CRITICAL)
**Location**: `apps/frontend/src/pages/AddData.tsx:1082-1090`, Multiple pages

**Problem**:
```typescript
// PROBLEM: Fire-and-forget invalidations
await Promise.all([
  utils.holdings.getAll.invalidate(),
  utils.accounts.getAll.invalidate(),
  utils.institutions.getAll.invalidate(),
  utils.tokens.getAll.invalidate(),
]);

// Then immediately access cache
await waitForCacheSettlement('holdings', createdHolding.holding.id);
```

**Issue**: 
- `invalidate()` triggers refetch but doesn't wait for completion
- `waitForCacheSettlement` polling starts immediately
- Race condition: new data might not be fetched yet when UI expects it
- Can cause "holding not found" errors or stale data display

**Impact**:
- Users see "Success" but holding doesn't appear
- Requires page refresh to see data
- Inconsistent UI state
- Poor user experience

**Solution**:
```typescript
// CORRECT: Wait for refetch to complete
await Promise.all([
  utils.holdings.getAll.refetch(),  // ✅ refetch() waits for completion
  utils.accounts.getAll.refetch(),
  utils.institutions.getAll.refetch(),
  utils.tokens.getAll.refetch(),
]);

// Now cache is guaranteed to have fresh data
// No need for polling
```

**Priority**: 🔴 CRITICAL - Causes data visibility issues

---

### 2. Optimistic Update Rollback Issues (CRITICAL)
**Location**: `apps/frontend/src/lib/cache/optimistic/entityManager.ts:168-186`

**Problem**:
```typescript
async onError(_error, _variables, context) {
  if (context?.institutionsAll) {
    utils.institutions.getAll.setData(undefined, context.institutionsAll);
  }
  // ❌ MISSING: No refetch to sync with server state
}
```

**Issue**:
- Optimistic update is rolled back to previous state
- But server might have partial data or different state
- Cache becomes out of sync with reality
- No refetch to verify actual server state

**Impact**:
- Stale data in cache after failed operations
- Cache doesn't reflect database truth
- Subsequent operations may use wrong data
- Requires page refresh to fix

**Solution**:
```typescript
async onError(_error, _variables, context) {
  // Rollback optimistic update
  if (context?.institutionsAll) {
    utils.institutions.getAll.setData(undefined, context.institutionsAll);
  }
  
  // ✅ CRITICAL: Refetch to sync with server truth
  await utils.institutions.getAll.refetch();
  
  // Optionally refetch related data
  if (context?.includesAccounts) {
    await utils.accounts.getAll.refetch();
  }
}
```

**Priority**: 🔴 CRITICAL - Causes cache desync

---

### 3. Missing Error Boundaries for Async Operations (CRITICAL)
**Location**: Multiple locations, especially `AddData.tsx`, `Holdings.tsx`

**Problem**:
```typescript
// Multiple async operations without proper error handling
const createHolding = async () => {
  const token = await createTokenFromExternal.mutateAsync(...);  // ❌ Can throw
  const holding = await createHolding.mutateAsync(...);  // ❌ Can throw
  await utils.holdings.getAll.invalidate();  // ❌ Can throw
  // No error handling - entire UI can crash
};
```

**Issue**:
- Async operations can throw at any step
- No error boundaries catch these errors
- Unhandled promise rejections
- App can crash or freeze

**Impact**:
- White screen of death
- Hung UI states
- Loss of user input
- Poor user experience

**Solution**:
```typescript
// ✅ CORRECT: Proper error handling
const createHolding = async () => {
  try {
    const token = await createTokenFromExternal.mutateAsync(...);
    const holding = await createHolding.mutateAsync(...);
    
    try {
      await utils.holdings.getAll.refetch();
    } catch (cacheError) {
      // Cache refresh failed, log but don't block
      console.error('Cache refresh failed:', cacheError);
    }
    
    return holding;
  } catch (error) {
    // Handle creation errors
    toast({
      title: 'Failed to create holding',
      description: error.message,
      variant: 'destructive',
    });
    throw error;  // Re-throw for caller to handle
  }
};

// Add error boundary at page level
<ErrorBoundary FallbackComponent={ErrorFallback}>
  <AddDataPage />
</ErrorBoundary>
```

**Priority**: 🔴 CRITICAL - Can crash app

---

## 🟠 HIGH PRIORITY ISSUES

### 4. WebSocket Reconnection Can Cause Duplicate Invalidations (HIGH)
**Location**: `apps/frontend/src/hooks/useRealtimeEntitySync.ts:68-154`

**Problem**:
```typescript
const handleMessage = useCallback(
  async (message: WebSocketMessage) => {
    // ❌ No deduplication - same message can be processed multiple times
    switch (entityType) {
      case 'holding':
        await invalidateHoldingsRelated(utils, { ... });
        break;
    }
  },
  [utils]  // ❌ utils changes frequently, callback recreated often
);
```

**Issue**:
- WebSocket can send duplicate messages on reconnect
- No message deduplication
- Multiple cache invalidations for same event
- `utils` dependency causes callback recreation

**Impact**:
- Unnecessary API calls
- Performance degradation
- Rate limiting issues
- Stale UI updates

**Solution**:
```typescript
// ✅ Add message deduplication
const processedMessages = useRef(new Set<string>());

const handleMessage = useCallback(
  async (message: WebSocketMessage) => {
    const messageId = `${message.entityType}-${message.operationType}-${message.entityId}-${message.timestamp}`;
    
    // Deduplicate
    if (processedMessages.current.has(messageId)) {
      console.debug('Skipping duplicate message:', messageId);
      return;
    }
    
    processedMessages.current.add(messageId);
    
    // Clean old messages (keep last 100)
    if (processedMessages.current.size > 100) {
      const toRemove = Array.from(processedMessages.current).slice(0, 50);
      toRemove.forEach(id => processedMessages.current.delete(id));
    }
    
    // Process message...
  },
  []  // ✅ No deps - utils accessed via closure
);
```

**Priority**: 🟠 HIGH - Impacts performance

---

### 5. Missing Index on token_prices Table (HIGH)
**Location**: Database schema, impacts `apps/backend/src/services/pricing.ts`

**Problem**:
```sql
-- Current query (no index on timestamp)
SELECT * FROM token_prices
WHERE token_id = ? AND base_token_id = ? AND timestamp >= ?
ORDER BY timestamp DESC
LIMIT 1;

-- ❌ No index on (token_id, base_token_id, timestamp)
-- Full table scan on every price lookup
```

**Issue**:
- Missing composite index on frequently queried columns
- Full table scans on hot path
- Performance degrades as price history grows
- Affects every holding valuation

**Impact**:
- Slow portfolio loading
- High database CPU
- Poor scalability
- Degraded user experience

**Solution**:
```sql
-- ✅ Add composite index
CREATE INDEX idx_token_prices_lookup 
ON token_prices(token_id, base_token_id, timestamp DESC);

-- Optionally add covering index for common queries
CREATE INDEX idx_token_prices_covering
ON token_prices(token_id, base_token_id, timestamp DESC)
INCLUDE (price, source);
```

**Migration**:
```typescript
// In Drizzle schema
export const tokenPrices = pgTable('token_prices', {
  // ... existing columns
}, (table) => ({
  // ✅ Add index
  lookupIdx: index('idx_token_prices_lookup')
    .on(table.tokenId, table.baseTokenId, table.timestamp.desc()),
}));
```

**Priority**: 🟠 HIGH - Performance bottleneck

---

### 6. Rate Limiter Not Shared Across Requests (HIGH)
**Location**: `apps/backend/src/services/pricing.ts:48-54`

**Problem**:
```typescript
export class PricingService {
  // ❌ Rate limiters are instance-level
  public readonly finnhubRateLimiter = new RateLimiter(50, 60 * 1000);
  public readonly coinGeckoRateLimiter = new RateLimiter(10, 60 * 1000);
}

// Multiple instances = multiple rate limiters
export const pricingService = new PricingService();  // Instance 1
export const anotherService = new PricingService();  // Instance 2 - separate limits!
```

**Issue**:
- If multiple service instances exist, each has separate rate limiter
- Total rate limit = instances × limit (not actual limit)
- Can exceed API provider limits
- Risk of account suspension

**Impact**:
- API rate limiting violations
- 429 errors from providers
- Service interruption
- Potential account bans

**Solution**:
```typescript
// ✅ Global rate limiters (singleton pattern)
const GLOBAL_RATE_LIMITERS = {
  finnhub: new RateLimiter(50, 60 * 1000),
  coinGecko: new RateLimiter(10, 60 * 1000),
  defiLlama: new RateLimiter(5, 1000),
};

export class PricingService {
  // Use global rate limiters
  private readonly finnhubRateLimiter = GLOBAL_RATE_LIMITERS.finnhub;
  private readonly coinGeckoRateLimiter = GLOBAL_RATE_LIMITERS.coinGecko;
}

// Or use dependency injection
export class PricingService {
  constructor(
    private readonly rateLimiters: {
      finnhub: RateLimiter;
      coinGecko: RateLimiter;
      defiLlama: RateLimiter;
    }
  ) {}
}
```

**Priority**: 🟠 HIGH - Risk of API bans

---

### 7. Potential N+1 Query in Portfolio Valuation (HIGH)
**Location**: `apps/backend/src/services/portfolio-valuation.ts:203-247`

**Problem**:
```typescript
// Loop processes holdings sequentially
for (const holding of holdings) {
  // ❌ Potential issue: Each iteration could trigger queries
  const balance = new Decimal(holding.balance);
  
  if (holding.tokenId === baseCurrency.id) {
    currentPrice = '1';
  } else {
    // Uses batched price - this is OK
    currentPrice = priceResults.get(holding.tokenId) || '0';
  }
  
  // But if we add more logic here, easy to introduce N+1
}
```

**Issue**:
- While current code uses batch pricing (good!), the loop pattern invites N+1 queries
- Any future developer might add per-iteration database calls
- No safeguards against accidental N+1 introduction
- Performance can degrade silently

**Impact**:
- Slow portfolio loading as holdings grow
- Database connection exhaustion
- Poor scalability

**Solution**:
```typescript
// ✅ Make it clear this is a pure transformation
const portfolioHoldings = holdings.map((holding) => {
  // Pure function - no async, no DB calls allowed
  const balance = new Decimal(holding.balance);
  
  const currentPrice = holding.tokenId === baseCurrency.id
    ? '1'
    : priceResults.get(holding.tokenId) || '0';
  
  const value = balance.mul(new Decimal(currentPrice)).toString();
  
  return {
    tokenSymbol: holding.tokenSymbol,
    balance: balance.toString(),
    currentPrice,
    value,
  };
});

// Aggregate separately
const totalValue = portfolioHoldings
  .reduce((sum, h) => sum.add(new Decimal(h.value)), new Decimal(0))
  .toString();
```

**Priority**: 🟠 HIGH - Scalability concern

---

### 8. No Timeout on External API Calls (HIGH)
**Location**: Multiple pricing providers

**Problem**:
```typescript
// ❌ No timeout - can hang indefinitely
const response = await fetchWithTimeout(url);

// fetchWithTimeout implementation
export async function fetchWithTimeout(url: string, options?: RequestInit) {
  // ❌ Has timeout but no retry logic, no circuit breaker
  return fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
}
```

**Issue**:
- API calls can hang if provider is slow
- No circuit breaker pattern
- Can block entire pricing pipeline
- No automatic retry for transient failures

**Impact**:
- Hung requests block thread pool
- Slow response times
- Poor user experience
- Resource exhaustion

**Solution**:
```typescript
// ✅ Add circuit breaker and retry
import { CircuitBreaker } from 'circuit-breaker-ts';

const circuitBreaker = new CircuitBreaker({
  timeout: 10000,  // 10s timeout
  errorThreshold: 5,  // Open after 5 failures
  resetTimeout: 30000,  // Try again after 30s
});

export async function fetchWithCircuitBreaker(
  url: string,
  options?: RequestInit,
  retries = 2
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await circuitBreaker.execute(() =>
        fetch(url, {
          ...options,
          signal: AbortSignal.timeout(10000),
        })
      );
    } catch (error) {
      if (attempt === retries) throw error;
      
      // Exponential backoff
      await new Promise(resolve => 
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }
  throw new Error('Max retries exceeded');
}
```

**Priority**: 🟠 HIGH - Reliability concern

---

## 🟡 MEDIUM PRIORITY ISSUES

### 9. Cache Stale Time Configuration Too Aggressive (MEDIUM)
**Location**: `apps/frontend/src/lib/trpc-provider.tsx:19-24`

**Problem**:
```typescript
defaultOptions: {
  queries: {
    staleTime: 30 * 1000, // 30 seconds
    refetchOnMount: 'always',  // ❌ Aggressive refetching
  },
},
```

**Issue**:
- 30s stale time is very short
- `refetchOnMount: 'always'` causes refetch every time component mounts
- Unnecessary API calls
- Poor performance on navigation

**Impact**:
- Increased API load
- Slower page loads
- Higher server costs
- Battery drain on mobile

**Recommended Solution**:
```typescript
defaultOptions: {
  queries: {
    // ✅ Reasonable defaults
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 10 * 60 * 1000, // 10 minutes
    refetchOnMount: false,  // Don't refetch if data is fresh
    refetchOnWindowFocus: false,  // Already disabled, good
    refetchOnReconnect: true,  // Good for offline recovery
  },
},
```

**Priority**: 🟡 MEDIUM - Performance optimization

---

### 10. No Monitoring/Metrics for Critical Paths (MEDIUM)
**Location**: Throughout application

**Problem**:
- No metrics on cache hit rates
- No timing data for slow operations
- No alerting on failures
- Difficult to diagnose production issues

**Impact**:
- Blind to performance issues
- Can't detect degradation
- Slow incident response
- Poor observability

**Solution**:
```typescript
// ✅ Add simple metrics
class Metrics {
  private counters = new Map<string, number>();
  private timings = new Map<string, number[]>();
  
  increment(metric: string, value = 1) {
    this.counters.set(metric, (this.counters.get(metric) || 0) + value);
  }
  
  timing(metric: string, duration: number) {
    if (!this.timings.has(metric)) {
      this.timings.set(metric, []);
    }
    this.timings.get(metric)!.push(duration);
  }
  
  report() {
    // Send to monitoring service (Sentry, DataDog, etc.)
    console.log('Metrics:', {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(
        Array.from(this.timings.entries()).map(([k, v]) => [
          k,
          { count: v.length, avg: v.reduce((a, b) => a + b) / v.length }
        ])
      ),
    });
  }
}

export const metrics = new Metrics();

// Usage
const start = Date.now();
const price = await pricingService.getTokenPrice(...);
metrics.timing('pricing.getTokenPrice', Date.now() - start);
metrics.increment('pricing.cache.hit', price !== '0' ? 1 : 0);
```

**Priority**: 🟡 MEDIUM - Observability

---

### 11. Inconsistent Error Messages (MEDIUM)
**Location**: Multiple routers and services

**Problem**:
```typescript
// Inconsistent error handling
throw new Error('Failed to create holding');  // Generic
throw new Error('Token not found');  // No context
throw new Error('Invalid account');  // Which account?
```

**Issue**:
- Error messages lack context
- Hard to debug from logs
- Poor user experience
- No error codes for handling

**Solution**:
```typescript
// ✅ Structured errors with context
class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Usage
throw new AppError(
  'Failed to create holding',
  'HOLDING_CREATE_FAILED',
  { accountId, tokenId, userId }
);

// Handle in error boundary
catch (error) {
  if (error instanceof AppError) {
    logger.error({
      code: error.code,
      message: error.message,
      context: error.context,
    });
    
    // Show user-friendly message
    toast({
      title: 'Operation Failed',
      description: getUserFriendlyMessage(error.code),
    });
  }
}
```

**Priority**: 🟡 MEDIUM - Developer experience

---

### 12. Missing Input Sanitization (MEDIUM)
**Location**: Multiple input handlers

**Problem**:
```typescript
// ❌ No sanitization
const accountData = {
  name: input.name.trim(),  // Only trim, no sanitization
  description: input.description?.trim() || null,
};
```

**Issue**:
- No HTML sanitization
- No SQL injection protection (Drizzle helps but not foolproof)
- No XSS prevention
- User input directly in queries

**Solution**:
```typescript
import DOMPurify from 'dompurify';

// ✅ Sanitize all user input
const accountData = {
  name: DOMPurify.sanitize(input.name.trim(), { ALLOWED_TAGS: [] }),
  description: input.description 
    ? DOMPurify.sanitize(input.description.trim(), { ALLOWED_TAGS: ['b', 'i', 'u'] })
    : null,
};

// Also validate length
if (accountData.name.length > 100) {
  throw new AppError('Account name too long', 'VALIDATION_ERROR');
}
```

**Priority**: 🟡 MEDIUM - Security concern

---

### 13. No Request Deduplication (MEDIUM)
**Location**: Frontend data fetching

**Problem**:
```typescript
// Multiple components can trigger same query
const Component1 = () => {
  const { data } = trpc.holdings.getAll.useQuery();  // Request 1
};

const Component2 = () => {
  const { data } = trpc.holdings.getAll.useQuery();  // Request 2
};

// ❌ Both fire simultaneously if cache is empty
```

**Issue**:
- Duplicate requests for same data
- Wasted bandwidth and API calls
- Server load
- Slower page loads

**Solution**:
```typescript
// ✅ tRPC actually handles this via httpBatchLink
// But need to ensure it's configured correctly

// In trpc-provider.tsx
trpc.createClient({
  links: [
    httpBatchLink({
      url: ...,
      maxBatchSize: 10,  // ✅ Batch multiple queries
    }),
  ],
});

// Also, React Query deduplicates automatically
// Just need to ensure cache is properly shared
```

**Priority**: 🟡 MEDIUM - Performance optimization

---

### 14. Large Bundle Size from Decimal.js (MEDIUM)
**Location**: Throughout app, especially pricing

**Problem**:
```typescript
import Decimal from 'decimal.js';  // ❌ 31KB gzipped

// Used everywhere for money calculations
const value = new Decimal(balance).mul(new Decimal(price));
```

**Issue**:
- Decimal.js is large (31KB)
- Included in every chunk that uses it
- Slows initial load

**Solution**:
```typescript
// ✅ Use smaller alternative or native BigInt
import { Decimal as BigDecimal } from 'big.js';  // 6KB gzipped

// Or for simple cases, use string math
function multiply(a: string, b: string): string {
  const aNum = parseFloat(a);
  const bNum = parseFloat(b);
  return (aNum * bNum).toFixed(18);  // Fixed precision
}

// Or use Intl.NumberFormat for display
const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});
```

**Priority**: 🟡 MEDIUM - Performance optimization

---

### 15. Unused Dependencies and Dead Code (MEDIUM)
**Location**: Throughout codebase

**Problem**:
- Unused imports
- Dead code paths
- Commented-out code
- Unused utility functions

**Impact**:
- Larger bundle size
- Confusing codebase
- Harder maintenance
- Slower builds

**Solution**:
```bash
# ✅ Find unused dependencies
bunx depcheck

# Remove unused exports
bunx ts-prune

# Remove dead code
bunx eslint --fix

# Analyze bundle
bunx vite-bundle-visualizer
```

**Priority**: 🟡 MEDIUM - Code quality

---

## 🟢 LOW PRIORITY ISSUES

### 16. No TypeScript Strict Mode (LOW)
**Location**: `tsconfig.json`

**Current**:
```json
{
  "compilerOptions": {
    "strict": false,  // ❌ Not strict
  }
}
```

**Recommended**:
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
  }
}
```

**Priority**: 🟢 LOW - Code quality (but important long-term)

---

### 17. Missing Accessibility Features (LOW)
**Location**: UI components

**Issues**:
- Missing ARIA labels
- No keyboard navigation hints
- Missing focus indicators
- No screen reader support

**Priority**: 🟢 LOW - Accessibility (but important for compliance)

---

### 18. No Internationalization (LOW)
**Location**: Hardcoded strings throughout

**Issue**:
- All text is hardcoded in English
- No i18n framework
- Can't support other languages

**Solution**:
```typescript
// ✅ Use react-i18next
import { useTranslation } from 'react-i18next';

const Component = () => {
  const { t } = useTranslation();
  return <h1>{t('holdings.title')}</h1>;
};
```

**Priority**: 🟢 LOW - Feature (not required yet)

---

### 19. Missing Component Testing (LOW)
**Location**: Frontend components

**Issue**:
- No React component tests
- No integration tests for user flows
- Only backend unit tests exist

**Solution**:
```typescript
// ✅ Add component tests
import { render, screen, waitFor } from '@testing-library/react';
import { AddData } from './AddData';

test('creates holding successfully', async () => {
  render(<AddData />);
  
  // ... interact with UI
  fireEvent.click(screen.getByText('Create Holding'));
  
  await waitFor(() => {
    expect(screen.getByText('Success')).toBeInTheDocument();
  });
});
```

**Priority**: 🟢 LOW - Testing (recommended but not urgent)

---

## 🎯 Recommended Action Plan

### Immediate (This Week)
1. **Fix cache invalidation race conditions** (#1) - Replace `invalidate()` with `refetch()`
2. **Add optimistic update rollback refetches** (#2) - Ensure cache sync
3. **Add error boundaries** (#3) - Prevent app crashes
4. **Fix WebSocket message deduplication** (#4) - Prevent duplicate updates

### Short-term (This Month)
5. **Add database indexes** (#5) - Critical for performance
6. **Fix rate limiter sharing** (#6) - Prevent API bans
7. **Add circuit breakers** (#8) - Improve reliability
8. **Review cache configuration** (#9) - Optimize performance

### Medium-term (Next Quarter)
9. **Add monitoring/metrics** (#10) - Improve observability
10. **Standardize error handling** (#11) - Better debugging
11. **Add input sanitization** (#12) - Security
12. **Optimize bundle size** (#14) - Performance

### Long-term (Future)
13. **Enable TypeScript strict mode** (#16) - Gradually
14. **Add accessibility features** (#17) - Compliance
15. **Add i18n support** (#18) - If going international
16. **Add comprehensive testing** (#19) - Quality assurance

---

## 📊 Metrics to Monitor Post-Fix

1. **Cache Hit Rate**: Should be >80% for frequently accessed data
2. **API Call Volume**: Should decrease by ~30% after caching fixes
3. **Error Rate**: Should be <1% for critical operations
4. **Page Load Time**: Should be <2s for dashboard
5. **Database Query Time**: P95 should be <100ms
6. **WebSocket Reconnection Rate**: Should be <5% of sessions

---

## 🔧 Tools and Libraries to Consider

1. **Monitoring**: Sentry, DataDog, or LogRocket
2. **Performance**: Lighthouse CI, bundle analyzer
3. **Security**: DOMPurify, helmet (for backend)
4. **Testing**: Playwright (E2E), Vitest (unit)
5. **Debugging**: React DevTools, tRPC DevTools

---

## 📝 Notes for Future Reviews

1. **Good Practices Observed**:
   - Batch pricing queries (excellent!)
   - Optimistic updates (good pattern)
   - Type safety with tRPC
   - Structured logging

2. **Areas for Improvement**:
   - Error handling consistency
   - Cache management sophistication
   - Performance monitoring
   - Testing coverage

3. **Architecture Strengths**:
   - Clean separation of concerns
   - Good service layer pattern
   - Well-organized codebase
   - Modern tech stack

---

**Review Completed**: 2025-10-09  
**Next Review Recommended**: After critical fixes are implemented  
**Status**: Findings documented, awaiting implementation

