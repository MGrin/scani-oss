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
import { DEMO_SIGNUP_TAG, SIGNUP_SOURCE_PARAM } from '../auth/signup-source';

/** Where "create your own account" sends a visitor who wants the real thing. */
const DEFAULT_SIGNUP_URL = 'https://app.scani.xyz';

/**
 * Adds the tag the funnel counts (SC-515).
 *
 * Here rather than in `SCANI_DEMO_SIGNUP_URL` because a configuration value is
 * a thing somebody can set wrong, and the one deployment that emits this link
 * is the one deployment that knows the click came from the demo. A self-hoster
 * pointing the variable at their own app gets the tag too, which is correct —
 * it says "from the demo", not "from ours".
 *
 * Idempotent, and never overwrites: a configured URL that already carries `src`
 * is making a claim of its own, and this is not the place to argue with it.
 */
function taggedAsDemo(signupUrl: string): string {
  let url: URL;
  try {
    url = new URL(signupUrl);
  } catch {
    // Not our validation boundary. An unparseable value still reaches the
    // banner unchanged, which is what it did before this existed.
    return signupUrl;
  }
  if (url.searchParams.has(SIGNUP_SOURCE_PARAM)) return signupUrl;
  url.searchParams.set(SIGNUP_SOURCE_PARAM, DEMO_SIGNUP_TAG);
  return url.toString();
}

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
    signupUrl: taggedAsDemo(configured && configured.length > 0 ? configured : DEFAULT_SIGNUP_URL),
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
