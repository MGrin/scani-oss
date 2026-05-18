import { AnalyticsProvider } from '@scani/analytics/client';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@scani/shared';
import { assertFrontendEnv } from '@scani/ui';
import { ErrorBoundary } from '@scani/ui/components/ErrorBoundary';
import { UpdateBanner } from '@scani/ui/components/UpdateBanner';
import { ThemeProvider } from '@scani/ui/contexts/ThemeContext';
import { Toaster } from '@scani/ui/ui/toaster';
import * as Sentry from '@sentry/react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { TRPCProvider } from '@/lib/trpc-provider';
import App from './App.tsx';
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

// Errors that originate outside our app code and are not actionable. Keeping
// them out of Sentry makes real regressions visible instead of drowning in
// third-party / user-environment noise. Matches are substring/regex against
// the error message (see Sentry's `ignoreErrors` docs).
const IGNORED_ERROR_PATTERNS: (string | RegExp)[] = [
  // Telegram Mini Apps / VK bridge SDKs injected by crypto-wallet browser
  // extensions. Our app doesn't import either SDK; the error surfaces as
  // `Error invoking postEvent: Method not found` inside a setTimeout frame
  // from an anonymous extension script. Nothing we can fix from the app.
  /Error invoking postEvent/i,
  /postEvent.*Method not found/i,
  // iOS Safari reports aborted fetches (navigation cancelled mid-flight,
  // tab backgrounded, flaky cell network) as `TypeError: Load failed`
  // instead of the standard `AbortError`. These fire as unhandled
  // rejections from tRPC/React Query even though the observer has already
  // unmounted, and they're indistinguishable from real load failures at
  // the message level. Drop them: if the fetch *really* failed, the user
  // sees an error state in the UI rendered by the query's error handler.
  /^Load failed$/,
  /TypeError: Load failed/,
  // Safari-specific variant of the same abort-during-navigation pattern.
  /cancelled$/i,
  // ResizeObserver loop warnings — benign, fired by many UI libs, not a
  // real error. Chrome/Safari both emit these as uncaught errors.
  /ResizeObserver loop/i,
];

// Frames from browser extensions, injected scripts, or `<anonymous>` eval
// frames aren't part of our app. If the *entire* stack is third-party, the
// error isn't ours to fix.
const THIRD_PARTY_FRAME_PATTERNS = [
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
  /^safari-web-extension:\/\//,
  /^safari-extension:\/\//,
  /^webkit-masked-url:/,
];

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.01,
    replaysOnErrorSampleRate: 1.0,
    ignoreErrors: IGNORED_ERROR_PATTERNS,
    // Drop events whose stack is exclusively third-party (extensions,
    // anonymous eval). `ignoreErrors` above catches known messages; this
    // catches the long tail of extension-injected crashes that rotate
    // their error messages faster than we can enumerate them. Then strip
    // PII (emails, JWTs, Authorization values) from whatever survives.
    beforeSend(event) {
      const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
      if (frames.length > 0) {
        const allThirdParty = frames.every((f) => {
          const url = f.abs_path || f.filename || '';
          if (!url) return false;
          return THIRD_PARTY_FRAME_PATTERNS.some((p) => p.test(url));
        });
        if (allThirdParty) return null;
      }
      return scrubSentryEvent(event);
    },
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <TRPCProvider>
          <AnalyticsProvider
            apiKey={import.meta.env.VITE_POSTHOG_KEY}
            apiHost={import.meta.env.VITE_POSTHOG_HOST}
            app="app"
          >
            <App />
          </AnalyticsProvider>
          <Toaster />
          <UpdateBanner />
        </TRPCProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// Register service worker for PWA support
// Update detection is handled by useAppUpdate hook + UpdateBanner component
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('[SW] Service Worker registered:', registration);
      })
      .catch((error) => {
        console.error('[SW] Service Worker registration failed:', error);
      });
  });
}
