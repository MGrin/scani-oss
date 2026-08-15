import { Outlet, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AuthProvider } from '@/contexts/AuthContext';
import { BaseCurrencyProvider } from '@/contexts/BaseCurrencyContext';
import { RealtimeProvider } from '@/contexts/RealtimeContext';
import { useFocusedFieldVisibility } from '@/hooks/useFocusedFieldVisibility';
import { useViewportScrollRecovery } from '@/hooks/useViewportScrollRecovery';
import { lazyRoute } from '@/lib/lazy-route';
import { Auth } from '@/pages/Auth';
import { AuthCallback } from '@/pages/AuthCallback';
import { InstallPromptHost } from '@/v2/components/InstallPromptHost';
import { UiVersionDocumentScope } from '@/v3/components/UiVersionDocumentScope';
import { LegacyV3PathRedirect, UiVersionGate } from '@/v3/components/UiVersionGate';
import { V2_BASE } from '@/v3/lib/ui-version';

/**
 * The two UI generations arrive separately (SC-132 #2).
 *
 * Both used to ship to everyone — 581 KB, 27% of the bundle — while exactly one
 * of them ever rendered, because only one of the two child routes below can
 * match. That was the single largest avoidable payload on the surface users
 * actually open, and on a cold Slow 4G load the whole 4183 ms to first
 * interactive control was download with **0 ms** of main-thread blocking.
 *
 * Splitting *here* rather than per page is deliberate. The boundary is the one
 * place the app already knows a reader will use one tree and not the other, and
 * it keeps the shell — auth, the providers below, the install prompt, the theme
 * and token layer — eagerly loaded and whole. Per-page splitting underneath
 * would make the interface appear in pieces, which is worse than appearing
 * late; `lazyRoute` carries the rest of that reasoning.
 *
 * **v2 stays fully reachable.** It is permanent chrome in both directions, not
 * a migration affordance — see `v3/lib/ui-version.ts`. It is deferred, not
 * removed, and a v2 reader pays one extra request for it exactly as a v3 reader
 * now does.
 */
const V2App = lazyRoute('classic interface', () => import('@/v2/V2App').then((m) => m.V2App));
const V3App = lazyRoute('interface', () => import('@/v3/V3App').then((m) => m.V3App));

function App() {
  // Both are document-level corrections to what iOS does around its software
  // keyboard, and both bugs were reported against the installed PWA in v2 as
  // well as v3 (SC-41). Mounting them here — above the split, above the auth
  // gate, so the sign-in form is covered too — is what gives one fix to both
  // trees without either shell knowing about it.
  useViewportScrollRecovery();
  useFocusedFieldVisibility();

  return (
    <AuthProvider>
      <InstallPromptHost />
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <UiVersionDocumentScope />
        <Routes>
          {/* Public auth routes */}
          <Route path="/auth" element={<Auth />} />
          <Route path="/signin" element={<Auth />} />
          <Route path="/signup" element={<Auth />} />
          <Route path="/auth/callback" element={<AuthCallback />} />

          {/* Everything authenticated hangs off one pathless layout route so
              the auth gate, the base currency and the realtime socket are
              resolved once, above the v2/v3 split.

              Both providers used to live inside V2App. `BaseCurrencyProvider`
              left `useBaseCurrency()` in v3 reading the context default — a
              USD placeholder that renders plausible money in the wrong
              currency (SC-36). `RealtimeProvider` was worse: `useJobStatus`
              calls `useRealtimeConnection()`, which *throws* when the context
              is absent, so every v3 screen that watches a job (Holdings, via
              `useHoldingRefresh`) rendered the error boundary instead of the
              page (SC-39). Anything both trees consume belongs here; the guard
              in `tests/v3/provider-scope.test.ts` fails the build if a third
              one is ever added below the split.

              Only one of the two child routes ever matches, so each provider
              still mounts exactly once — `users.getBaseCurrency` fires once
              and exactly one WebSocket is opened, as before. They stay below
              `ProtectedRoute` on purpose: both are user-scoped and must not
              run while signed out. */}
          <Route
            element={
              <ProtectedRoute>
                <BaseCurrencyProvider>
                  <RealtimeProvider>
                    <Outlet />
                  </RealtimeProvider>
                </BaseCurrencyProvider>
              </ProtectedRoute>
            }
          >
            {/* The classic interface, at its own prefix since V3-19. It owns
                its own layout (AppShell), its own `TooltipProvider` (v3 mounts
                its own too, so neither tree depends on the other's), and nested
                routes for dashboard, holdings, accounts, etc. Its route table
                is relative and every link in it is built from `V2_ROUTES`, so
                the move cost one prefix in that table and nothing else.

                Registered before the root splat because that splat matches
                everything. */}
            <Route path={`${V2_BASE}/*`} element={<V2App />} />

            {/* Where v3 lived while it was being built. Kept as a redirect so a
                tester's bookmark survives the flip. */}
            <Route path="/v3/*" element={<LegacyV3PathRedirect />} />

            {/* v3 is what `/` serves now. The gate above it honours a stored
                preference for the classic UI by sending the same screen to
                `/v2`; v3's own catch-all hands anything it does not route —
                every pre-flip bookmark to a v2-only screen — across to v2. */}
            <Route
              path="/*"
              element={
                <UiVersionGate>
                  <V3App />
                </UiVersionGate>
              }
            />
          </Route>
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
