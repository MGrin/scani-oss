# Auth Flow Implementation - Frontend V2

**Date:** January 13, 2025  
**Status:** ✅ COMPLETE

## Overview

Successfully implemented the complete authentication flow in frontendV2, copied exactly from the existing frontend implementation. The auth system uses Supabase Auth with magic links (browser) and magic codes (PWA).

## Files Created

### Authentication Context

- **File:** `apps/frontendV2/src/contexts/AuthContext.tsx`
- **Purpose:** Manages authentication state, Supabase auth integration
- **Features:**
  - PWA detection for code vs link authentication
  - Magic link authentication for browsers
  - Magic code (OTP) authentication for PWA
  - Session management with Supabase
  - Sign out and password reset

### Auth Pages

1. **`apps/frontendV2/src/pages/Auth.tsx`**

   - Main authentication page
   - Email form with validation (react-hook-form + zod)
   - Displays magic code input for PWA users
   - Displays "check your email" for browser users
   - Automatic account creation for new users

2. **`apps/frontendV2/src/pages/AuthCallback.tsx`**
   - Handles OAuth callback from magic links
   - Verifies authentication session
   - Syncs user with backend via tRPC
   - Redirects to dashboard on success
   - Error handling with user-friendly messages

### Supporting Components

1. **`apps/frontendV2/src/components/MagicCodeInput.tsx`**

   - 6-digit OTP input component
   - Auto-focus and auto-advance between inputs
   - Paste support for full code
   - Resend code functionality
   - Keyboard navigation (arrows, backspace)

2. **`apps/frontendV2/src/components/ProtectedRoute.tsx`**

   - Route guard for authenticated-only pages
   - Redirects unauthenticated users to `/auth`
   - Loading state during auth check
   - Preserves return URL for post-login redirect

3. **`apps/frontendV2/src/components/ui/loading.tsx`**
   - LoadingSpinner component (multiple sizes)
   - LoadingButton component
   - LoadingDots component
   - ProgressIndicator component
   - LoadingOverlay component
   - AccessibleLoading component with reduced motion support

### Other Files

- **`apps/frontendV2/src/pages/Dashboard.tsx`** - Placeholder dashboard page
- **`apps/frontendV2/src/App.tsx`** - Updated with auth routes and provider
- **`apps/frontendV2/src/main.tsx`** - Wrapped App in TRPCProvider and AuthProvider

## Routes Configuration

### Public Routes

- `/auth` - Main authentication page
- `/signin` - Alias for `/auth`
- `/signup` - Alias for `/auth`
- `/auth/callback` - OAuth callback handler

### Protected Routes

- `/` - Dashboard (placeholder, requires authentication)

## Authentication Flow

### Browser Flow (Magic Link)

1. User enters email on `/auth` page
2. System detects browser mode (not PWA)
3. Sends magic link email with callback URL
4. User clicks link in email
5. Opens `/auth/callback` in browser
6. System verifies session and syncs user with backend
7. Redirects to dashboard

### PWA Flow (Magic Code)

1. User enters email on `/auth` page
2. System detects PWA mode (standalone display mode)
3. Sends 6-digit OTP code email
4. User enters code in MagicCodeInput component
5. System verifies OTP with Supabase
6. Redirects to dashboard

## Dependencies Added

```json
{
  "zod": "^3.25.76" // Added during implementation
}
```

## Technical Details

### PWA Detection

- Uses `isPWA()` from `@/lib/pwa-utils`
- Checks `display-mode: standalone` media query
- Checks iOS standalone mode
- Different auth flow based on detection

### User Sync

- After successful authentication, calls `trpc.users.getCurrent.useQuery()`
- Syncs Supabase user with local PostgreSQL database
- Non-blocking - authentication succeeds even if sync fails
- Logs warning if sync fails

### Security

- JWT tokens managed by Supabase
- Auto-refresh session
- Auth state subscription for real-time updates
- Magic links expire (handled by Supabase)
- OTP codes expire in 10 minutes

### Accessibility

- All forms have proper labels and IDs
- Loading states with proper ARIA attributes
- Error messages clearly displayed
- Keyboard navigation support
- Focus management in OTP input
- Reduced motion support in loading components

## Testing

### Dev Server

- ✅ Running on http://localhost:5174
- ✅ No TypeScript errors
- ✅ No build errors
- ✅ All imports resolved

### Manual Testing Checklist

- [ ] Visit http://localhost:5174 (should redirect to /auth)
- [ ] Enter email in auth form
- [ ] Verify magic link email received (browser mode)
- [ ] Click magic link and verify redirect to dashboard
- [ ] Test PWA mode (install as PWA, enter email)
- [ ] Verify OTP code received (PWA mode)
- [ ] Enter OTP code and verify redirect to dashboard
- [ ] Test protected route access (logged out should redirect to /auth)
- [ ] Test sign out functionality

## Notes

- Auth flow copied **exactly** from existing frontend as requested
- No modifications made to the auth logic
- Reuses existing Supabase configuration
- Compatible with existing backend user sync
- PWA features preserved (code vs link authentication)
- All accessibility features preserved

## Next Steps

1. Test authentication flow in browser
2. Test authentication flow in PWA (install app first)
3. Implement layout components (header, sidebar, etc.)
4. Implement feature pages (Holdings, Accounts, Institutions, Tokens)
5. Copy remaining UI components from existing frontend
