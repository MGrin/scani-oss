import { MAILPIT_URL } from './mailpit';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

export type StackProbe = readonly [label: string, url: string];

/**
 * Every service the visual and shots setups reach over HTTP before a browser
 * starts (SC-796).
 *
 * Mailpit is here because both setups sign a user in by magic link, and the
 * sign-in reads the code out of Mailpit. It used to be missing, so a stack
 * without Mailpit passed this check and then died inside sign-in with a bare
 * `TypeError: fetch failed` naming no service and no URL.
 *
 * The worker is a dependency too (seeding enqueues jobs it consumes) and is
 * NOT probed: it publishes no port. `waitForJob` names it when it is missing.
 */
export const STACK_PROBES: readonly StackProbe[] = [
  ['api', `${API_BASE_URL}/health`],
  ['frontend', BASE_URL],
  ['mailpit', `${MAILPIT_URL}/api/v1/info`],
];

export async function assertStackUp(probes: readonly StackProbe[] = STACK_PROBES): Promise<void> {
  for (const [label, url] of probes) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new Error(
        `${label} not reachable at ${url} (${(err as Error).message}). ` +
          'Start the stack first: `bun dev:stack` from the repo root.'
      );
    }
  }
}
