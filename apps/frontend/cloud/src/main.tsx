import { AnalyticsProvider } from '@scani/analytics/client';
import { assertFrontendEnv, ErrorBoundary, ThemeProvider, UpdateBanner } from '@scani/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import { TrpcProvider } from './lib/trpc-provider';

// VITE_DATA_PROVIDER_URL is allowed to be empty (same-origin proxy mode in
// dev), but if it's set it MUST parse cleanly. The check fires at startup
// so a misconfigured prod build crashes loud rather than booting against
// an unreachable URL.
assertFrontendEnv([
  {
    name: 'VITE_DATA_PROVIDER_URL',
    value: import.meta.env.VITE_DATA_PROVIDER_URL,
    required: false,
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider storageKey="scani-cloud-theme">
        <TrpcProvider>
          <BrowserRouter>
            <AnalyticsProvider
              apiKey={import.meta.env.VITE_POSTHOG_KEY}
              apiHost={import.meta.env.VITE_POSTHOG_HOST}
              app="cloud"
            >
              <App />
            </AnalyticsProvider>
          </BrowserRouter>
          <UpdateBanner />
        </TrpcProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// Register the service worker so the app keeps working offline and the
// UpdateBanner / useAppUpdate hook can detect new deploys. Production-only
// so dev iteration isn't disturbed by stale caches.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('[SW] Service Worker registration failed:', error);
    });
  });
}
