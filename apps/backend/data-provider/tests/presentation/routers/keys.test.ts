/**
 * SC-585 — `keys.create` does not take `tier` from the caller.
 *
 * It used to, and a signed-up user minted itself an `internal` key and got
 * HTTP 200 for it. `internalProcedure` gates `storage.*` and `email.send`
 * on that column, so leaving the input in place would be a lock whose key
 * is handed to the caller.
 *
 * The refusal is a 400 naming `tier`, not a silent strip. Zod drops an
 * unknown key by default, and a 200 over an ignored authorization request
 * leaves the caller believing it holds something it does not.
 */

import { describe, expect, test } from 'bun:test';
import { keysRouter } from '../../../src/presentation/routers/keys';
import type { DataProviderContext } from '../../../src/presentation/trpc';
import { effectiveHourlyRequestLimit } from '../../../src/presentation/trpc';
import { buildAuthedContext } from '../../helpers/test-context';

function caller(overrides: Partial<DataProviderContext> = {}) {
  return keysRouter.createCaller({
    ...buildAuthedContext(),
    cloudUser: { id: 'user-1', email: 'someone@example.com', name: null },
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: `tier` is not in the input type — that is the point
  }) as any;
}

describe('keys.create', () => {
  test('refuses a caller-supplied tier, naming it', async () => {
    const err = await caller()
      .create({ name: 'mine', tier: 'internal' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String((err as Error).message)).toContain('tier');
  });

  test("refuses 'free' too — the input is gone, not merely constrained", async () => {
    // A schema that merely rejected privileged tiers would pass the test
    // above while leaving the column caller-controlled.
    await expect(caller().create({ name: 'mine', tier: 'free' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  test('accepts a name alone, and gets past input validation', async () => {
    // No cloud DB is installed here, so this reaches `requireDb()` and
    // stops there. PRECONDITION_FAILED is the gate opening: a BAD_REQUEST
    // would mean the two refusals above prove nothing about `tier`.
    await expect(caller().create({ name: 'mine' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });
});

/**
 * SC-816 — the console can say what actually bounds a key.
 *
 * `cloud_api_keys.quota_monthly_requests` is read by nothing on the request
 * path (SC-583), so the only thing bounding a key is the hourly budget the
 * usage middleware consumes — one global default, keyed by apiKeyId. That
 * number lived only in the data-provider's env and reached no wire contract,
 * which is why SC-583 had to ship the qualitative sentence "a fixed number of
 * requests per hour" rather than the figure.
 *
 * A PROCEDURE, NOT A FIELD ON EVERY `keys.list` ROW (mgrin, 2026-08-29). The
 * limit is one global default today, so a per-row field would ship the same
 * number on every row and imply per-key configuration that does not exist —
 * the defect SC-583 removed, one layer down. The decisive argument is the
 * contract asymmetry rather than the cosmetics: adding a per-key field LATER
 * is additive, and retracting one external callers already read is breaking.
 * Prefer the shape you can extend over the one you would have to retract.
 */
describe('keys.limits', () => {
  test('reports the hourly budget the middleware actually enforces', async () => {
    const limits = await caller({ hourlyRequestLimit: 1000 }).limits();
    expect(limits).toEqual({ hourlyRequestLimit: 1000 });
  });

  /**
   * Null is "no limit is enforced", and it deliberately covers BOTH of the
   * env's off states — absent, and an explicit `0`.
   *
   * That collapse is NOT the SC-582 defect repeated. There, conflating the two
   * made a deliberately-off control indistinguishable from an overlooked one
   * for an OPERATOR, who is the reader who can act on the difference. This is
   * a customer-facing wire: "no limit applies to you" is the whole of what a
   * caller can act on, and "nobody has decided yet" is a statement about our
   * deployment hygiene that does not belong on a public API. The operator
   * distinction stays where it can be acted on — the boot line and
   * `describeCostControls`, which keep the tri-state.
   */
  test('says null when nothing is enforced, for both off states', async () => {
    expect(await caller({ hourlyRequestLimit: null }).limits()).toEqual({
      hourlyRequestLimit: null,
    });
  });

  test('needs a session, like every other procedure on this router', async () => {
    const anon = keysRouter.createCaller({
      ...buildAuthedContext(),
      cloudUser: null,
      // biome-ignore lint/suspicious/noExplicitAny: exercising the unauthenticated path
    } as any);
    await expect(anon.limits()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  /**
   * It must not reach `requireDb()`. The limit is a property of the
   * deployment, not of a row, so a console that can list no keys can still
   * say what bounds the ones it cannot see — and an OSS self-hoster running
   * without CLOUD_MANAGEMENT_ENABLED gets an answer rather than a
   * PRECONDITION_FAILED.
   */
  test('answers without a cloud database installed', async () => {
    await expect(caller({ hourlyRequestLimit: 1000 }).limits()).resolves.toBeDefined();
  });
});

/**
 * The predicate `keys.limits` reports on must stay identical to the one
 * `index.ts` installs the limiter on:
 *
 *     const hourlyQuota = env.CLOUD_QUOTA_HOURLY_DEFAULT;
 *     if (hourlyQuota !== null && hourlyQuota > 0) { installQuotaLimiter(...) }
 *
 * It is duplicated rather than shared, because sharing it would mean importing
 * from the boot entrypoint — a `divergent` file whose two copies are
 * hand-applied and therefore free to drift apart. This is the check that
 * notices if they do. The failure it guards against is the whole ticket in
 * reverse: a console confidently printing a bound nothing enforces.
 */
describe('effectiveHourlyRequestLimit', () => {
  test('a positive budget is enforced and is reported as itself', () => {
    expect(effectiveHourlyRequestLimit(1000)).toBe(1000);
    expect(effectiveHourlyRequestLimit(1)).toBe(1);
  });

  test('an explicit 0 installs no limiter, so it reports no limit', () => {
    expect(effectiveHourlyRequestLimit(0)).toBeNull();
  });

  test('an absent value installs no limiter, so it reports no limit', () => {
    expect(effectiveHourlyRequestLimit(null)).toBeNull();
  });

  /**
   * 0 and null are DIFFERENT facts to an operator (SC-582) and the same fact
   * to a caller. Asserting they agree here is what makes the collapse a
   * decision somebody took rather than a case someone forgot.
   */
  test('the two off states are indistinguishable on the wire, deliberately', () => {
    expect(effectiveHourlyRequestLimit(0)).toBe(effectiveHourlyRequestLimit(null));
  });
});
