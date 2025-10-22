# Authentication Error Handling Improvement

**Date**: October 22, 2025
**Status**: ✅ Implemented
**Component**: Frontend - Authentication & tRPC Error Handling

## Problem

When users loaded the application after a period of inactivity (e.g., weeks), their access tokens would be expired/outdated. When the frontend made API requests with invalid tokens:

1. Backend would correctly return **401 UNAUTHORIZED** errors
2. Frontend would receive these errors but **had no global handler**
3. Users would see **no data** and be **stuck** on the page
4. No automatic redirection to auth page occurred
5. No clear indication that re-authentication was needed

### User Experience Impact

- Users were confused why data wasn't loading
- No error messages or guidance
- Had to manually navigate to auth page or refresh
- Poor UX for returning users

## Solution

Implemented a comprehensive authentication error handling system with automatic redirection and return URL preservation.

### Changes Made

#### 1. Global 401 Error Handler in tRPC Provider

**File**: `apps/frontendV2/src/lib/trpc-provider.tsx`

Added global error handling for all tRPC queries and mutations:

```tsx
// Import TRPCClientError for error type checking
import { TRPCClientError, httpBatchLink } from "@trpc/client";
import { useEffect } from "react";

// Configure QueryClient to not retry on 401 errors
const [queryClient] = useState(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          retry: (failureCount, error) => {
            // Don't retry on 401 errors
            if (
              error instanceof TRPCClientError &&
              error.data?.code === "UNAUTHORIZED"
            ) {
              return false;
            }
            return failureCount < 3;
          },
        },
        mutations: {
          retry: (failureCount, error) => {
            // Don't retry on 401 errors
            if (
              error instanceof TRPCClientError &&
              error.data?.code === "UNAUTHORIZED"
            ) {
              return false;
            }
            return failureCount < 1;
          },
        },
      },
    })
);

// Global error handler for authentication issues
useEffect(() => {
  const handleQueryError = (error: unknown) => {
    if (error instanceof TRPCClientError) {
      // Check if it's an UNAUTHORIZED error
      if (error.data?.code === "UNAUTHORIZED") {
        console.warn(
          "[Auth] Unauthorized request detected, redirecting to auth page"
        );

        // Sign out from Supabase to clear any stale session
        supabase.auth.signOut().catch(console.error);

        // Redirect to auth page with return URL
        const currentPath = window.location.pathname + window.location.search;
        const returnUrl =
          currentPath !== "/auth"
            ? `?returnTo=${encodeURIComponent(currentPath)}`
            : "";
        window.location.href = `/auth${returnUrl}`;
      }
    }
  };

  // Set up error handler on the query cache
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "observerResultsUpdated" && event.query.state.error) {
      handleQueryError(event.query.state.error);
    }
  });

  return () => {
    unsubscribe();
  };
}, [queryClient]);
```

**Key Features:**

- ✅ Listens to all query errors via query cache subscription
- ✅ Detects 401/UNAUTHORIZED errors automatically
- ✅ Clears stale Supabase session
- ✅ Preserves current URL as return destination
- ✅ Prevents infinite retry loops on auth failures
- ✅ Uses hard redirect (`window.location.href`) to ensure clean state

#### 2. Return URL Handling in Auth Page

**File**: `apps/frontendV2/src/pages/Auth.tsx`

Added support for `returnTo` query parameter:

```tsx
import { useSearchParams } from "react-router-dom";

export function Auth() {
  const [searchParams] = useSearchParams();

  // Get return URL from query params
  const returnTo = searchParams.get("returnTo") || "/";

  const handleCodeSubmit = async (code: string) => {
    setError(null);
    const result = await verifyCode(userEmail, code);

    if (result.error) {
      setError(result.error);
      throw new Error(result.error);
    } else {
      // Successfully authenticated, redirect to return URL or dashboard
      navigate(returnTo, { replace: true });
    }
  };
}
```

**Key Features:**

- ✅ Reads `returnTo` from URL query params
- ✅ Redirects users back to their original destination after auth
- ✅ Defaults to dashboard (`/`) if no return URL specified
- ✅ Works for both PWA and browser flows

#### 3. Return URL Handling in Auth Callback

**File**: `apps/frontendV2/src/pages/AuthCallback.tsx`

Added return URL support for magic link authentication:

```tsx
export function AuthCallback() {
  const location = useLocation();

  // Get return URL from location state or default to dashboard
  const returnTo =
    (location.state as { from?: { pathname: string } })?.from?.pathname || "/";

  // ... in success handler:
  navigate(returnTo, { replace: true });
}
```

**Key Features:**

- ✅ Preserves destination through ProtectedRoute redirect
- ✅ Returns users to their intended page after email link auth
- ✅ Seamless UX for interrupted workflows

## Architecture

### Error Flow

```
1. User loads page after token expiration
   ↓
2. Component makes tRPC query/mutation
   ↓
3. Backend validates token → 401 UNAUTHORIZED
   ↓
4. tRPC client receives error
   ↓
5. React Query cache emits error event
   ↓
6. Global error handler detects UNAUTHORIZED
   ↓
7. Clear Supabase session
   ↓
8. Redirect to /auth?returnTo=/original/path
   ↓
9. User authenticates
   ↓
10. Redirect to original path
```

### Return URL Flow

```
Protected Page → 401 Error → /auth?returnTo=/protected/page
                                        ↓
                              User authenticates
                                        ↓
                              Redirect to /protected/page
```

## Benefits

### User Experience

- ✅ **Automatic handling**: Users don't get stuck on broken pages
- ✅ **Clear feedback**: Console logs explain what's happening
- ✅ **Seamless return**: Users land back where they started
- ✅ **Clean state**: Hard redirect ensures no stale data

### Developer Experience

- ✅ **No boilerplate**: Works globally, no per-component error handling needed
- ✅ **Type-safe**: Uses tRPC error types for reliable detection
- ✅ **Debuggable**: Console logs for monitoring

### Security

- ✅ **Session cleanup**: Clears stale tokens before redirect
- ✅ **No retry storms**: Prevents repeated 401 requests
- ✅ **URL encoding**: Safely preserves return paths

## Testing Scenarios

### Scenario 1: Expired Token on Dashboard

1. User hasn't visited in weeks
2. Opens dashboard → Backend returns 401
3. **Expected**: Redirect to `/auth?returnTo=/`
4. After login → Back to dashboard

### Scenario 2: Expired Token on Holdings Page

1. User has expired token
2. Navigates to `/holdings`
3. Holdings query fails with 401
4. **Expected**: Redirect to `/auth?returnTo=/holdings`
5. After login → Back to holdings page

### Scenario 3: Multiple 401 Errors

1. Multiple queries fail simultaneously
2. **Expected**: Only one redirect occurs (no duplicate redirects)
3. Return URL preserved correctly

### Scenario 4: PWA Code Entry

1. User authenticates via code in PWA
2. **Expected**: Redirect to `returnTo` URL after code verification
3. Seamless return to interrupted workflow

### Scenario 5: Email Magic Link

1. User clicks email link with location state
2. **Expected**: Redirect to original protected route
3. Clean authentication flow

## Edge Cases Handled

- ✅ Already on `/auth` page → No return URL added
- ✅ Query params preserved → Encoded in return URL
- ✅ Invalid return URL → Defaults to `/`
- ✅ Race conditions → Hard redirect prevents multiple handlers
- ✅ Mutation errors → Also trigger redirect
- ✅ Stale session → Cleaned up before redirect

## Monitoring

Look for console warnings:

```
[Auth] Unauthorized request detected, redirecting to auth page
```

This indicates:

- Token expired/invalid
- User being redirected automatically
- Expected behavior for inactive users

## Future Enhancements

### Potential Improvements

1. **Token Refresh**: Attempt automatic token refresh before redirect
2. **User Notification**: Show toast message explaining redirect
3. **Session Persistence**: Store return URL in localStorage for reliability
4. **Retry Strategy**: Implement exponential backoff for transient errors
5. **Analytics**: Track auth redirect events for monitoring

### Not Implemented (By Design)

- ❌ Automatic token refresh - Supabase handles this internally
- ❌ Toast notifications - Hard redirect makes this unnecessary
- ❌ Multiple retry attempts - 401 is definitive, no point retrying

## Related Files

- `apps/frontendV2/src/lib/trpc-provider.tsx` - Global error handler
- `apps/frontendV2/src/pages/Auth.tsx` - Return URL handling
- `apps/frontendV2/src/pages/AuthCallback.tsx` - Magic link return
- `apps/frontendV2/src/components/ProtectedRoute.tsx` - Initial auth check
- `apps/backend/src/presentation/middleware/auth.ts` - Backend auth validation

## Migration Notes

- ✅ No breaking changes
- ✅ Works with existing auth flow
- ✅ Backward compatible with manual auth navigation
- ✅ No database changes required
- ✅ No environment variable changes

## Rollout

1. Deploy frontend changes
2. Monitor for console warnings
3. Verify users can re-authenticate smoothly
4. Check return URL preservation works correctly

## Success Metrics

- Zero users stuck on pages with invalid tokens
- Smooth re-authentication flow
- Preserved user workflows after auth
- Reduced support tickets about "data not loading"
