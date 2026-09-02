import {
  isThirdPartyOnlyStack,
  SENTRY_IGNORED_ERROR_PATTERNS,
} from '@scani/shared/utils/sentry-noise';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@scani/shared/utils/sentry-scrubber';
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
import { warmInterface } from '@/lib/warm-interface';
import { applyDocumentUiVersion } from '@/v3/lib/ui-version';
import App from './App.tsx';
import i18n from './i18n';
import { applyFormatLocale, browserStorage, readStoredRegion } from './i18n/format-locale';
import './index.css';

// Fail loudly if the build pipeline forgot to stage VITE_API_URL — better
// a clear error surface in /var/log than a silently broken bundle hitting
// localhost:3001 forever.
//
// `allowSameOriginPath` because the published `scani/frontend-app` image is
// built with `VITE_API_URL=/api`: one artefact, any hostname, nginx inside the
// container proxying to `API_UPSTREAM`. Without it this call threw here, at
// module scope, and every published build was a blank page (SC-467).
assertFrontendEnv([
  {
    name: 'VITE_API_URL',
    value: import.meta.env.VITE_API_URL,
    required: true,
    allowSameOriginPath: true,
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
    // Performance tracing, which a deployed build reported ZERO of for a month
    // while reporting errors normally (SC-822) — a `pageload` and a
    // `navigation` transaction, on top of the default integrations
    // (Breadcrumbs, GlobalHandlers, LinkedErrors, HttpContext, Dedupe, …).
    //
    // IT WAS OMITTED FOR A REASON THAT NO LONGER HOLDS, AND THE REASON IS KEPT
    // BECAUSE IT IS THE ONE THAT WOULD PUT IT BACK. This block used to read:
    // `browserTracingIntegration` and `replayIntegration` compile predicates
    // via `new Function(...)`, our CSP is `script-src 'self'` with no
    // `'unsafe-eval'`, and the SDK surfaced the block as an unhandled EvalError
    // on every page load.
    //
    // Measured against the installed 8.55.2 on 2026-09-02: `new Function(` and
    // `eval(` appear in 0 of the 430 built `.js` files across `@sentry/react`,
    // `@sentry/browser`, `@sentry-internal/browser-utils` and `@sentry/core`,
    // with `browserTracingIntegration` itself found in 14 of them — the control
    // that the search could see anything at all.
    //
    // A GREP IS NOT A PAGE LOAD, so this was then verified by building `dist/`
    // and serving it under the exact `script-src 'self'` CSP from
    // `public/_headers` with a `report-uri`, in a real Chromium: 13 loads, ZERO
    // violations reported and zero error envelopes, and `pageload` transactions
    // transmitted. The control is what makes that zero a measurement — a page
    // with one inline `<script>` served from the same origin under the same
    // header DID report a `script-src-elem` violation, so the channel works.
    //
    // `replayIntegration` is a separate package and stays OFF: nothing here
    // measured it, and it is the heavier of the two in both bytes and spend.
    //
    // `tracePropagationTargets` is deliberately left at the SDK default
    // (same-origin and localhost), which is the safe default for BOTH
    // deployment shapes this app supports. A split-origin one — bundle on one
    // host, API on another — would otherwise add `sentry-trace` and `baggage`
    // to a cross-origin preflight the API has not been asked about. The
    // single-origin shape, where nginx proxies `/api` from the same host, is
    // same-origin already: it propagates and needs no preflight at all.
    integrations: [Sentry.browserTracingIntegration()],
    // The same rate the backend uses. Raising it is a spend decision, not a
    // wiring one, so it is not made here.
    tracesSampleRate: 0.1,
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
// before React's first render, is what stops the document painting a frame
// without the token layer — the attribute has to be on the element the page is
// already painting. It used to come back off on a classic-UI route, which is
// why a component kept it in step across navigations; with one interface it is
// set once and stays (SC-423).
applyDocumentUiVersion(document.documentElement);

// Same reasoning one line up, for `<html lang>` and `<html dir>` (SC-201).
// `FormatLocaleProvider` keeps both in step from here on; doing it once before
// React's first render is what stops the document announcing the wrong language
// — and, once a right-to-left locale exists, painting one frame left-to-right.
// The detector has already run: `./i18n` initialises i18next at import time.
applyFormatLocale(
  i18n.resolvedLanguage ?? i18n.language,
  readStoredRegion(browserStorage()),
  document
);

// The interface arrives as its own chunk (SC-132 #2), and it is requested here
// rather than when the route renders — that is below the auth gate, so it would
// otherwise queue behind the session probe and give the split back every
// millisecond it saved. No-ops for a device that has never had a session; it is
// going to the sign-in form and needs none of it.
void warmInterface(window.location.pathname);

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
