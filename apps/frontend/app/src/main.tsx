import {
  isThirdPartyOnlyStack,
  SENTRY_IGNORED_ERROR_PATTERNS,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '@scani/shared';
import { assertFrontendEnv } from '@scani/ui';
import { ErrorBoundary } from '@scani/ui/components/ErrorBoundary';
import { UpdateBanner } from '@scani/ui/components/UpdateBanner';
import { ThemeProvider } from '@scani/ui/contexts/ThemeContext';
import {
  listenForServiceWorkerReports,
  registerServiceWorker,
  setServiceWorkerReporter,
} from '@scani/ui/lib/service-worker';
import { Toaster } from '@scani/ui/ui/toaster';
import * as Sentry from '@sentry/react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { TRPCProvider } from '@/lib/trpc-provider';
import { warmUiVersion } from '@/lib/warm-ui-version';
import { activeUiVersion, applyDocumentUiVersion } from '@/v3/lib/ui-version';
import App from './App.tsx';
import './i18n';
import './index.css';

// Fail loudly if the build pipeline forgot to stage VITE_API_URL — better
// a clear error surface in /var/log than a silently broken bundle hitting
// localhost:3001 forever.
assertFrontendEnv([
  {
    name: 'VITE_API_URL',
    value: import.meta.env.VITE_API_URL,
    required: true,
  },
]);

// Sentry init — DSN populated at build time from VITE_SENTRY_DSN
// (GH Actions secret `VITE_SENTRY_DSN_FRONTEND`). No-op if unset.
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    // No `integrations` array: the default integrations (Breadcrumbs,
    // GlobalHandlers, LinkedErrors, HttpContext, Dedupe, etc) do not
    // require `eval` and run cleanly under our strict CSP
    // (`script-src 'self'`, no `'unsafe-eval'`). Both
    // `browserTracingIntegration` and `replayIntegration` internally
    // compile predicate functions via `new Function(...)`, which CSP
    // blocks — and the SDK surfaces the block as an unhandled
    // EvalError on every page load (Sentry issue SCANI-FRONTEND-9).
    // If tracing or session replay is needed in the future, either
    // gate behind an opt-in build flag that also relaxes CSP, or
    // wait for upstream Sentry to ship an eval-free build of those
    // integrations.
    // Message-level noise filters live in `@scani/shared` so they're unit
    // tested — see packages/business/shared/tests/utils/sentry-noise.test.ts.
    ignoreErrors: SENTRY_IGNORED_ERROR_PATTERNS,
    // Drop events whose stack is exclusively third-party (extensions,
    // anonymous eval). `ignoreErrors` above catches known messages; this
    // catches the long tail of extension-injected crashes that rotate
    // their error messages faster than we can enumerate them. Then strip
    // PII (emails, JWTs, Authorization values) from whatever survives.
    beforeSend(event) {
      if (isThirdPartyOnlyStack(event)) return null;
      return scrubSentryEvent(event);
    },
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
}

// The v3 token block hangs off `<html data-ui="v3">` (V3-19). Setting it here,
// before React's first render, is what stops the document flashing the other
// design system's background while `UiVersionDocumentScope`'s effect is still
// queued — the attribute has to be on the element the page is already painting.
applyDocumentUiVersion(activeUiVersion(window.location.pathname), document.documentElement);

// v2 and v3 arrive as separate chunks (SC-132 #2), and the one this reader will
// get is requested here rather than when the route renders — that is below the
// auth gate, so it would otherwise queue behind the session probe and give the
// split back every millisecond it saved. No-ops for a device that has never had
// a session; it is going to the sign-in form and needs neither.
void warmUiVersion(window.location.pathname);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <TRPCProvider>
          <App />
          <Toaster />
          <UpdateBanner />
        </TRPCProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// Register service worker for PWA support
// Update detection is handled by useAppUpdate hook + UpdateBanner component
if (import.meta.env.PROD) {
  // A registration that fails is a degraded app, not a broken one, so the
  // helper logs at `warn` when `/sw.js` is still being served. Only a script
  // that genuinely is not served reaches Sentry — a `sw.js` 404ing on every
  // load is a real defect and has to stay visible.
  setServiceWorkerReporter((error, detail) => {
    Sentry.captureException(error, {
      level: 'error',
      tags: { area: 'service-worker' },
      extra: { detail },
    });
  });

  // The worker reports an asset it could not get served — an unreachable
  // network is not one of them, it degrades over those silently.
  listenForServiceWorkerReports();

  window.addEventListener('load', () => {
    void registerServiceWorker();
  });
}
