# 🚀 Quick Wins - Immediate Improvements for Scani

**Updated:** September 30, 2025  
**Status:** 4/9 improvements completed via UX overhaul

This document provides **actionable, copy-paste ready improvements** you can implement right now.

## ✅ Completed Improvements (September 2025)

The following items have been **completed** as part of the UX implementation:

- ✅ **#6: User-Friendly Error Messages** → `useEnhancedToast` hook deployed
- ✅ **#8: Loading States with Skeletons** → Professional empty states deployed (even better than skeletons)
- ✅ **Onboarding wizard** → 4-step guided tour for new users
- ✅ **Accessibility improvements** → WCAG AA compliant

See `/docs/UX_REVIEW_UPDATE.md` for details on completed work.

---

## 1. Fix Pricing Service Performance (30 min) ⚡

**Problem:** Portfolio with 20 tokens takes 20+ seconds to load due to sequential API calls.

**Solution:** Add parallel fetching with rate limit pooling

```typescript
// apps/backend/src/services/pricing.ts

// Add this method to PricingService class:
private async parallelFetchWithRateLimit<T>(
  items: T[],
  concurrency: number,
  fetchFn: (item: T) => Promise<any>
): Promise<any[]> {
  const results: any[] = [];
  const queue = [...items];

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      try {
        const result = await fetchFn(item);
        results.push(result);
      } catch (error) {
        console.error('Fetch error:', error);
        results.push(null);
      }
    }
  };

  // Run multiple workers in parallel
  const workers = Array(concurrency).fill(null).map(() => worker());
  await Promise.all(workers);

  return results;
}

// Modify getTokenPrices method:
async getTokenPrices(tokens: Token[], baseCurrencySymbol: string, timestamp: Date) {
  // Group tokens by provider first
  const tokensByProvider = this.groupTokensByProvider(tokens);

  // Fetch from each provider in parallel (5 concurrent requests per provider)
  const allResults = await Promise.all(
    Object.entries(tokensByProvider).map(async ([provider, providerTokens]) => {
      return this.parallelFetchWithRateLimit(
        providerTokens,
        5, // 5 concurrent requests
        async (token) => {
          await this.getAppropriateLimiter(provider).acquire();
          return this.fetchPriceFromProvider(provider, token, baseCurrencySymbol, timestamp);
        }
      );
    })
  );

  // Merge and cache results
  return this.mergeAndCacheResults(allResults);
}

private groupTokensByProvider(tokens: Token[]): Record<string, Token[]> {
  const groups: Record<string, Token[]> = {};

  for (const token of tokens) {
    const provider = this.getProviderForToken(token);
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(token);
  }

  return groups;
}
```

**Expected Result:** 20 tokens: 24s → 3-5s (80% faster)

---

## 2. Add Database Index for Portfolio Queries (5 min) 🔍

**Problem:** Portfolio valuation queries are slow for users with many holdings.

**Solution:** Add composite index

```typescript
// apps/backend/src/db/schema.ts

export const holdings = pgTable(
  "holdings",
  {
    // ... existing fields
  },
  (table) => ({
    // Existing indexes:
    userIdIdx: index("idx_holdings_user_id").on(table.userId),
    accountIdIdx: index("idx_holdings_account_id").on(table.accountId),
    tokenIdIdx: index("idx_holdings_token_id").on(table.tokenId),

    // ADD THIS: Composite index for portfolio queries
    userTokenIdx: index("idx_holdings_user_token").on(
      table.userId,
      table.tokenId
    ),
  })
);
```

Then generate and run migration:

```bash
cd apps/backend
bun run db:generate
bun run db:migrate
```

**Expected Result:** 30-50% faster portfolio queries for users with 50+ holdings

---

## 3. Add Dashboard Composite Endpoint (20 min) 📊

**Problem:** Dashboard makes 4 separate API calls, causing multiple loading states.

**Solution:** Create single endpoint

```typescript
// apps/backend/src/routers/dashboard.ts (NEW FILE)
import { getUserId } from "../middleware/auth";
import { protectedProcedure, router } from "../trpc";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";

export const dashboardRouter = router({
  getData: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    // Fetch all dashboard data in parallel
    const [holdings, accounts, portfolioValue, baseCurrency] =
      await Promise.all([
        db
          .select()
          .from(schema.holdings)
          .where(eq(schema.holdings.userId, userId)),

        db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.userId, userId)),

        // Reuse existing portfolio calculation logic
        ctx.portfolioValuationService.getUserPortfolioValue(userId),

        // Get base currency
        db
          .select()
          .from(schema.users)
          .innerJoin(
            schema.tokens,
            eq(schema.users.baseCurrencyId, schema.tokens.id)
          )
          .where(eq(schema.users.id, userId))
          .limit(1),
      ]);

    return {
      holdings,
      accounts,
      portfolioValue,
      baseCurrency: baseCurrency[0],
      timestamp: new Date(),
    };
  }),
});
```

```typescript
// apps/backend/src/router.ts
import { dashboardRouter } from "./routers/dashboard";

export const appRouter = router({
  // Add this:
  dashboard: dashboardRouter,

  // ... existing routers
});
```

```tsx
// apps/frontend/src/pages/Dashboard.tsx
// Replace multiple queries with:
const { data, isLoading } = trpc.dashboard.getData.useQuery();

// Access all data:
const holdings = data?.holdings;
const accounts = data?.accounts;
const portfolioValue = data?.portfolioValue;
const baseCurrency = data?.baseCurrency;
```

**Expected Result:** 4 requests → 1 request, faster load, atomic data

---

## 4. Fix Bundle Size with Icon Tree-Shaking (10 min) 📦

**Problem:** lucide-react imports entire icon library (~2MB).

**Solution:** Use individual imports

```typescript
// Create apps/frontend/src/lib/icons.ts
export { Camera } from "lucide-react/dist/esm/icons/camera";
export { Plus } from "lucide-react/dist/esm/icons/plus";
export { Wallet } from "lucide-react/dist/esm/icons/wallet";
export { Zap } from "lucide-react/dist/esm/icons/zap";
export { Trash2 } from "lucide-react/dist/esm/icons/trash-2";
export { Edit } from "lucide-react/dist/esm/icons/edit";
export { ChevronDown } from "lucide-react/dist/esm/icons/chevron-down";
// ... add only icons you actually use
```

Then update all imports:

```tsx
// Before:
import { Camera, Plus, Wallet } from "lucide-react";

// After:
import { Camera, Plus, Wallet } from "@/lib/icons";
```

**Expected Result:** ~400KB bundle size reduction

---

## 5. Add Route-Based Code Splitting (15 min) 🎯

**Problem:** Entire app loads upfront, even unused pages.

**Solution:** Lazy load routes

```tsx
// apps/frontend/src/App.tsx
import { lazy, Suspense } from "react";
import { LoadingSpinner } from "@/components/ui/loading";

// Lazy load page components
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Holdings = lazy(() => import("@/pages/Holdings"));
const Accounts = lazy(() => import("@/pages/Accounts"));
const Institutions = lazy(() => import("@/pages/Institutions"));
const Tokens = lazy(() => import("@/pages/Tokens"));
const QuickAddHolding = lazy(() => import("@/pages/QuickAddHolding"));
const Settings = lazy(() => import("@/pages/Settings"));

function App() {
  return (
    <AuthProvider>
      <TRPCProvider>
        <ThemeProvider>
          <ThemeLoader>
            <Router>
              <Suspense fallback={<LoadingSpinner fullScreen />}>
                <Routes>
                  {/* All routes stay the same, components are lazy loaded */}
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/holdings" element={<Holdings />} />
                  {/* ... etc */}
                </Routes>
              </Suspense>
            </Router>
          </ThemeLoader>
        </ThemeProvider>
      </TRPCProvider>
    </AuthProvider>
  );
}
```

**Expected Result:** 60-70% smaller initial bundle, faster first load

---

## 6. Add User-Friendly Error Messages (15 min) 💬

**Problem:** Technical errors shown to users.

**Solution:** Error mapping layer

```typescript
// apps/frontend/src/lib/error-messages.ts
export const ERROR_MESSAGES = {
  PRICE_UNAVAILABLE: {
    title: "Price temporarily unavailable",
    message:
      "We're having trouble fetching the latest price. Your holdings are safe.",
    action: "Retry",
  },
  RATE_LIMIT: {
    title: "Please wait a moment",
    message: "We're updating your portfolio. This may take a few seconds.",
    action: null,
  },
  NETWORK_ERROR: {
    title: "Connection issue",
    message: "Please check your internet connection and try again.",
    action: "Retry",
  },
  UNAUTHORIZED: {
    title: "Session expired",
    message: "Please sign in again to continue.",
    action: "Sign in",
  },
  NOT_FOUND: {
    title: "Not found",
    message: "The item you're looking for doesn't exist or has been deleted.",
    action: "Go back",
  },
} as const;

export function getUserFriendlyError(error: unknown) {
  if (error instanceof TRPCError) {
    switch (error.code) {
      case "UNAUTHORIZED":
        return ERROR_MESSAGES.UNAUTHORIZED;
      case "NOT_FOUND":
        return ERROR_MESSAGES.NOT_FOUND;
      default:
        return {
          title: "Something went wrong",
          message: "We're working on fixing this. Please try again.",
          action: "Retry",
        };
    }
  }

  return {
    title: "Unexpected error",
    message: "An unexpected error occurred. Please try again.",
    action: "Retry",
  };
}
```

```tsx
// Use in components:
import { getUserFriendlyError } from "@/lib/error-messages";

const mutation = trpc.holdings.create.useMutation({
  onError: (error) => {
    const friendlyError = getUserFriendlyError(error);
    toast({
      title: friendlyError.title,
      description: friendlyError.message,
      variant: "destructive",
    });
  },
});
```

---

## 7. Add Security Headers (5 min) 🔒

**Problem:** Missing security headers in production.

**Solution:** Add to backend

```typescript
// apps/backend/src/index.ts
app.onBeforeHandle(({ set }) => {
  set.headers = {
    ...set.headers,
    // Prevent MIME sniffing
    "X-Content-Type-Options": "nosniff",
    // Prevent clickjacking
    "X-Frame-Options": "DENY",
    // Enable XSS protection
    "X-XSS-Protection": "1; mode=block",
    // Force HTTPS
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    // Control referrer
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Permissions policy
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  };
});
```

---

## 8. Add Loading Skeleton for Better UX (15 min) ⏳

**Problem:** Empty loading states look broken.

**Solution:** Add skeleton components

```tsx
// apps/frontend/src/components/ui/skeleton.tsx
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export function HoldingRowSkeleton() {
  return (
    <div className="flex items-center justify-between p-4 border-b">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-[200px]" />
          <Skeleton className="h-3 w-[150px]" />
        </div>
      </div>
      <div className="space-y-2 text-right">
        <Skeleton className="h-4 w-[100px] ml-auto" />
        <Skeleton className="h-3 w-[80px] ml-auto" />
      </div>
    </div>
  );
}
```

```tsx
// Use in Dashboard:
{
  isLoading ? (
    <>
      <HoldingRowSkeleton />
      <HoldingRowSkeleton />
      <HoldingRowSkeleton />
    </>
  ) : (
    holdings.map((holding) => <HoldingRow key={holding.id} {...holding} />)
  );
}
```

---

## 9. Enable Transactions UI (2 min) ✅

**Problem:** Core feature is hidden.

**Solution:** Uncomment the routes

```tsx
// apps/frontend/src/App.tsx

// Remove all these comments:
// HIDDEN: Transaction UI temporarily hidden

// Uncomment:
import { Transactions } from "@/pages/Transactions";

<Route
  path="/transactions"
  element={
    <ProtectedRoute>
      <Layout>
        <Transactions />
      </Layout>
    </ProtectedRoute>
  }
/>;
```

---

## 10. Add Request Caching with SWR Pattern (10 min) 🚀

**Problem:** Same data fetched multiple times across components.

**Solution:** Configure React Query properly

```typescript
// apps/frontend/src/lib/trpc-provider.tsx

const [queryClient] = useState(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          // Increase cache time
          cacheTime: 15 * 60 * 1000, // 15 minutes
          staleTime: 60 * 1000, // 1 minute

          // Enable background refetching
          refetchOnWindowFocus: true,
          refetchOnReconnect: true,

          // Retry configuration
          retry: 2,
          retryDelay: (attemptIndex) =>
            Math.min(1000 * 2 ** attemptIndex, 30000),

          // Use cached data while revalidating
          refetchOnMount: false,
        },
      },
    })
);
```

---

## Priority Order

**Completed (Sep 2025):**

- ✅ #6: User-Friendly Error Messages (useEnhancedToast)
- ✅ #8: Loading Skeletons → Empty States (better solution)
- ✅ Onboarding wizard
- ✅ Accessibility improvements

**Remaining priorities:**

1. **Fix Pricing Service** (30 min) - Biggest user-facing impact ⬅️ **DO THIS FIRST**
2. **Add Database Index** (5 min) - Prevent future slowdowns
3. **Add Security Headers** (5 min) - Production safety
4. **Dashboard Composite Endpoint** (20 min) - Better UX
5. **Code Splitting** (15 min) - Faster initial load
6. **Icon Tree-Shaking** (10 min) - Smaller bundle
7. **Request Caching** (10 min) - Performance boost

**Total Time: ~1.5 hours for all remaining improvements**

---

## Validation Commands

After implementing, run these to verify:

```bash
# Test performance
cd apps/backend
bun dev:verbose
# Watch for SQL query counts and response times

# Check bundle size
cd apps/frontend
bun run build
du -sh dist/assets/*.js

# Run tests (after fixing test setup)
cd ../..
bun test --coverage

# Check for type errors
bun run type-check
```

---

## Next Steps

After these quick wins, focus on:

1. Fix test suite (critical for quality assurance)
2. Add portfolio analytics charts (competitive parity)
3. Implement onboarding wizard (critical for digital nomad users)
4. Add Redis for WebSocket scaling (if traffic grows)
5. Build mobile app or PWA (digital nomads are mobile-first)
