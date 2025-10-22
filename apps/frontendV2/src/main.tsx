import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { TRPCProvider } from "@/lib/trpc-provider";
import App from "./App.tsx";
import "./index.css";

// Initialize Sentry
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_RELEASE_VERSION || "1.0.0",

  // Performance monitoring
  tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,

  // Capture React errors
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],

  // Session replay
  replaysSessionSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
  replaysOnErrorSampleRate: 1.0,

  // Ignore certain errors
  ignoreErrors: [
    "Network Error",
    "Failed to fetch",
    "Load failed",
    "Script error",
    "Non-Error promise rejection captured",
  ],

  // Don't send events in development unless explicitly enabled
  enabled: import.meta.env.PROD
    ? true
    : import.meta.env.VITE_SENTRY_ENABLED === "true",
});

console.log(
  "✅ Sentry initialized successfully (frontend)",
  import.meta.env.PROD ? true : import.meta.env.VITE_SENTRY_ENABLED === "true"
);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Failed to find the root element");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <TRPCProvider>
        <App />
        <Toaster />
      </TRPCProvider>
    </ThemeProvider>
  </React.StrictMode>
);

// Register service worker for PWA support
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        console.log("[SW] Service Worker registered:", registration);

        // Check for updates periodically
        setInterval(() => {
          registration.update();
        }, 60 * 60 * 1000); // Check every hour
      })
      .catch((error) => {
        console.error("[SW] Service Worker registration failed:", error);
      });
  });
}
