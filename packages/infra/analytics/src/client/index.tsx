import posthog from 'posthog-js';
import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import type { AnalyticsApp } from '../events';

export { ANALYTICS_EVENTS, type AnalyticsApp, type AnalyticsEvent } from '../events';

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

let initialized = false;

interface InitOptions {
  apiKey?: string;
  apiHost?: string;
  app: AnalyticsApp;
}

// Boots posthog-js once. No-ops without an apiKey (dev / self-host) or
// outside the browser, so the SPAs can call it unconditionally.
export function initAnalytics(opts: InitOptions): void {
  if (initialized || typeof window === 'undefined' || !opts.apiKey) return;
  initialized = true;
  posthog.init(opts.apiKey, {
    api_host: opts.apiHost || DEFAULT_POSTHOG_HOST,
    // Only identified (signed-in) users get a person profile — anonymous
    // visitors are still counted but stay cheaper and more private.
    person_profiles: 'identified_only',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    respect_dnt: true,
    session_recording: { maskAllInputs: true, maskTextSelector: '*' },
    loaded: (ph) => {
      ph.register({ app: opts.app, language: navigator.language });
    },
  });
}

export function identifyUser(user: { id: string; email?: string | null }): void {
  if (!initialized) return;
  posthog.identify(user.id, user.email ? { email: user.email } : undefined);
}

export function resetAnalytics(): void {
  if (!initialized) return;
  posthog.reset();
}

export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}

export function capturePageview(path?: string): void {
  if (!initialized) return;
  posthog.capture('$pageview', path ? { $current_url: window.location.origin + path } : undefined);
}

interface AnalyticsContextValue {
  capture: typeof capture;
  identify: typeof identifyUser;
  reset: typeof resetAnalytics;
}

const AnalyticsContext = createContext<AnalyticsContextValue>({
  capture,
  identify: identifyUser,
  reset: resetAnalytics,
});

export function AnalyticsProvider(props: {
  apiKey?: string;
  apiHost?: string;
  app: AnalyticsApp;
  children: ReactNode;
}) {
  useEffect(() => {
    initAnalytics({ apiKey: props.apiKey, apiHost: props.apiHost, app: props.app });
  }, [props.apiKey, props.apiHost, props.app]);
  return (
    <AnalyticsContext.Provider value={{ capture, identify: identifyUser, reset: resetAnalytics }}>
      {props.children}
    </AnalyticsContext.Provider>
  );
}

export function useAnalytics(): AnalyticsContextValue {
  return useContext(AnalyticsContext);
}

// Captures a $pageview on client-side route changes. The initial load is
// already captured by posthog.init, so the first invocation is skipped.
// Pass `useLocation().pathname + search` from react-router so this package
// stays router-agnostic.
export function useCapturePageview(path: string): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    capturePageview(path);
  }, [path]);
}

// Identifies the user with PostHog when signed in, and resets on sign-out
// so the next anonymous session isn't merged into the previous person.
export function useAnalyticsIdentify(
  user: { id: string; email?: string | null } | null | undefined
): void {
  const id = user?.id ?? null;
  const email = user?.email ?? null;
  const wasIdentified = useRef(false);
  useEffect(() => {
    if (id) {
      identifyUser({ id, email });
      wasIdentified.current = true;
    } else if (wasIdentified.current) {
      resetAnalytics();
      wasIdentified.current = false;
    }
  }, [id, email]);
}
