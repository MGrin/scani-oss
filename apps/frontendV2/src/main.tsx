import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { UpdateBanner } from '@/components/UpdateBanner';
import { Toaster } from '@/components/ui/toaster';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { TRPCProvider } from '@/lib/trpc-provider';
import App from './App.tsx';
import './index.css';

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
