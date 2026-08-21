import { Navigate, Outlet, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { InstallPromptHost } from '@/components/InstallPromptHost';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { TimezoneReporter } from '@/components/TimezoneReporter';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { BaseCurrencyProvider } from '@/contexts/BaseCurrencyContext';
import { FormatLocaleProvider } from '@/contexts/FormatLocaleContext';
import { RealtimeProvider } from '@/contexts/RealtimeContext';
import { useFocusedFieldVisibility } from '@/hooks/useFocusedFieldVisibility';
import { useViewportScrollRecovery } from '@/hooks/useViewportScrollRecovery';
import { lazyRoute } from '@/lib/lazy-route';
import { Auth } from '@/pages/Auth';
import { AuthCallback } from '@/pages/AuthCallback';
import { LegacyV2PathRedirect, LegacyV3PathRedirect } from '@/v3/components/LegacyPathRedirects';

/**
 * The interface arrives separately from the shell (SC-132 #2).
 *
 * The split was drawn here because this is where the app used to know a reader
 * would use one of two trees and not the other — 581 KB of which 27% of the
 * bundle was the one they would never see. One of those trees is gone (SC-423)
 * and the boundary is still the right one: it keeps the shell — auth, the
 * providers below, the install prompt, the theme and token layer — eagerly
 * loaded and whole, and defers everything behind the auth gate that a
 * signed-out visitor never renders. Per-page splitting underneath would make
 * the interface appear in pieces, which is worse than appearing late;
 * `lazyRoute` carries the rest of that reasoning.
 */
const V3App = lazyRoute('interface', () => import('@/v3/V3App').then((m) => m.V3App));

/**
 * The sign-in screen, except where signing in is not a thing that exists.
 *
 * The demo deployment refuses `/api/auth/*` outright, so this form could only
 * ever fail there — and a visitor who reaches `/auth` from a bookmark, a shared
 * link or the PWA's start URL would be looking at a dead end instead of the
 * portfolio they were sent to see (SC-466).
 */
function AuthScreen() {
  const { isDemo } = useAuth();
  return isDemo ? <Navigate to="/" replace /> : <Auth />;
}

function App() {
  // Both are document-level corrections to what iOS does around its software
  // keyboard, and both bugs were reported against the installed PWA in v2 as
  // well as v3 (SC-41). Mounting them here — above the split, above the auth
  // gate, so the sign-in form is covered too — is what gives one fix to both
  // trees without either shell knowing about it.
  useViewportScrollRecovery();
  useFocusedFieldVisibility();

  return (
    // Above the auth gate and above the v2/v3 split, because dates and numbers
    // are rendered on the sign-in screen and in both trees. It owns `<html
    // lang>` / `<html dir>` too, which are document-wide by definition.
    <FormatLocaleProvider>
      <AuthProvider>
        <InstallPromptHost />
        <Router
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <Routes>
            {/* Public auth routes */}
            <Route path="/auth" element={<AuthScreen />} />
            <Route path="/signin" element={<AuthScreen />} />
            <Route path="/signup" element={<AuthScreen />} />
            <Route path="/auth/callback" element={<AuthCallback />} />

            {/* Everything authenticated hangs off one pathless layout route so
              the auth gate, the base currency and the realtime socket are
              resolved once, above the lazily loaded interface.

              Both providers used to live inside the classic interface's own
              root, below this point. `BaseCurrencyProvider` left
              `useBaseCurrency()` in v3 reading the context default — a USD
              placeholder that renders plausible money in the wrong currency
              (SC-36). `RealtimeProvider` was worse: `useJobStatus` calls
              `useRealtimeConnection()`, which *throws* when the context is
              absent, so every v3 screen that watches a job (Holdings, via
              `useHoldingRefresh`) rendered the error boundary instead of the
              page (SC-39). Both defects survived the tree that caused them,
              which is why the guard in `tests/v3/provider-scope.test.ts`
              outlives it too: it fails the build if a third provider is ever
              added below this route rather than above it.

              They stay below `ProtectedRoute` on purpose: both are user-scoped
              and must not run while signed out. */}
            <Route
              element={
                <ProtectedRoute>
                  <BaseCurrencyProvider>
                    <RealtimeProvider>
                      {/* Renders nothing; fills `users.timezone`, which is what
                        the payment-due reminder selects on (SC-226). Here
                        rather than on a screen because a zone captured only
                        from Settings is a feature that works only for people
                        who open Settings. */}
                      <TimezoneReporter />
                      <Outlet />
                    </RealtimeProvider>
                  </BaseCurrencyProvider>
                </ProtectedRoute>
              }
            >
              {/* The two prefixes the app has answered on and no longer
                serves: `/v3` while v3 was being built, and `/v2` for the
                classic interface until SC-423 deleted it. Both are stripped
                rather than left to fall through — they are in bookmarks, in
                shared links, and in the installed PWA's start URL for anyone
                who had chosen the classic UI. Registered before the root splat
                because that splat matches everything. */}
              <Route path="/v3/*" element={<LegacyV3PathRedirect />} />
              <Route path="/v2/*" element={<LegacyV2PathRedirect />} />

              {/* v3 is what `/` serves. Anything it does not route reaches its
                own not-found screen, inside its own shell — it used to be
                handed to the classic interface, which is what made that tree
                the terminal 404 for the whole app. */}
              <Route path="/*" element={<V3App />} />
            </Route>
          </Routes>
        </Router>
      </AuthProvider>
    </FormatLocaleProvider>
  );
}

export default App;
