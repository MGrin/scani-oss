/**
 * Demo-mode configuration for the API (SC-466).
 *
 * Separate from `env.ts` on purpose. `env.ts` describes the service; this
 * describes a deployment posture that changes who the service will talk to,
 * and it is read by the tRPC context on every request — so it caches, exposes
 * a reset for tests, and refuses ambiguity rather than coercing it.
 *
 * The env flag is only the first of three layers; `@scani/domain/demo`'s
 * `mode.ts` documents the other two and owns the one that matters.
 */

import { isDemoModeRequested } from '@scani/domain/demo';

/** Where "create your own account" sends a visitor who wants the real thing. */
const DEFAULT_SIGNUP_URL = 'https://app.scani.xyz';

export interface DemoConfig {
  readonly enabled: boolean;
  /** Absolute URL of the real product's sign-up screen. */
  readonly signupUrl: string;
}

let cached: DemoConfig | undefined;

export function loadDemoConfig(env: Record<string, string | undefined> = process.env): DemoConfig {
  if (cached) return cached;
  const enabled = isDemoModeRequested(env);
  const configured = env.SCANI_DEMO_SIGNUP_URL?.trim();
  cached = {
    enabled,
    signupUrl: configured && configured.length > 0 ? configured : DEFAULT_SIGNUP_URL,
  };
  return cached;
}

/** Tests only. Production reads the environment once and never changes posture. */
export function resetDemoConfig(): void {
  cached = undefined;
}

export function isDemoMode(): boolean {
  return loadDemoConfig().enabled;
}
