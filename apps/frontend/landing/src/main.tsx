import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// createRoot (not hydrateRoot): the prerendered markup is re-rendered
// from scratch on the client. hydrateRoot adopts the existing DOM and is
// marginally faster for LCP, but it is sensitive to server/client
// divergence — a hydration failure left every scroll-revealed section
// stuck invisible on Safari. createRoot always mounts cleanly, so we
// trade the small LCP win for a render path that cannot break.
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// PostHog is loaded + initialised after first paint so posthog-js stays
// out of the initial bundle — it is the landing's biggest mobile-perf
// cost and nothing render-critical depends on it (the contact form's
// capture() calls no-op until init completes). The dynamic import
// is a deliberate, localized exception to the repo's top-level-import
// rule: main.tsx is the app boot entry and analytics is non-critical.
function initTelemetry(): void {
  void import('@scani/analytics/client').then(({ initAnalytics }) => {
    initAnalytics({
      apiKey: import.meta.env.VITE_POSTHOG_KEY,
      apiHost: import.meta.env.VITE_POSTHOG_HOST,
      app: 'landing',
    });
  });
}

if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(initTelemetry);
} else {
  setTimeout(initTelemetry, 1);
}
