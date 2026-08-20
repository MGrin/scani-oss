/**
 * SC-327. Every process that holds a connection to the worker-embedded Redis
 * must run a strand watchdog against it.
 *
 * This is a source-level guard rather than a behavioural one because the
 * failure it defends against is an omission, and an omission has no behaviour
 * to assert on. It is also the exact shape this system keeps being bitten by:
 * the first deploy-time guard named `scani-backend` alone, and
 * `scani-data-provider` then looped `ENOTFOUND` every two seconds for THREE
 * HOURS, found only because somebody was reading logs for another reason. The
 * symptom moves to whichever consumer nobody named. `REDIS_CONSUMERS` in
 * `scripts/recycle-redis-consumers.sh` is the same idea for the repair side.
 *
 * A new backend service that opens a Redis connection belongs in this list.
 */
import { describe, expect, test } from 'bun:test';

const BACKEND = new URL('../../../../apps/backend/', import.meta.url);

const ENTRYPOINTS = ['api', 'data-provider', 'worker'] as const;

describe('redis strand watchdog wiring', () => {
  for (const app of ENTRYPOINTS) {
    test(`${app} arms a strand watchdog on its Redis connection`, async () => {
      const source = await Bun.file(new URL(`${app}/src/index.ts`, BACKEND)).text();

      expect(source).toContain('startRedisStrandWatchdog(');
      // The alert is worthless if it only reaches stdout: `/health` answering
      // 200 through a total outage is precisely how this went unnoticed for
      // twenty minutes. It has to leave the machine. `sentryCapture` alone
      // would prove nothing — all three files already call it for unrelated
      // errors — so this asserts on the strand error specifically reaching it.
      expect(source).toContain('strandedRedisError(');
      expect(source).toContain('sentryCapture(err');
    });
  }
});
