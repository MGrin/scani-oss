import { ErrorBoundary, ThemeProvider } from '@scani/ui';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import { TrpcProvider } from './lib/trpc-provider';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider storageKey="scani-cloud-theme">
        <TrpcProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </TrpcProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
