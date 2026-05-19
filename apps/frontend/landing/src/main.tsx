import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// hydrateRoot (not createRoot): the page ships fully prerendered, so we
// adopt the existing DOM instead of discarding and repainting it — that
// repaint was pushing Largest Contentful Paint well past First Paint.
hydrateRoot(
  document.getElementById('root') as HTMLElement,
  <StrictMode>
    <App />
  </StrictMode>
);

// PostHog is loaded + initialised after first paint so posthog-js stays
// out of the initial bundle — it is the landing's biggest mobile-perf
// cost and nothing render-critical depends on it (the contact/waitlist
// forms' capture() calls no-op until init completes). The dynamic import
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
