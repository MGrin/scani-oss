/**
 * SC-585 — the nine internal facades must refuse a customer key.
 *
 * `storage.*` and `email.send` exist only because the api and worker call
 * them through `@scani/cloud-client` (SC-208). They sat on the one bearer
 * surface with nothing asking who was calling, so a key minted by an
 * anonymous cloud signup read another tenant's object, overwrote one,
 * deleted one it had never written, obtained a presigned URL usable
 * outside the API with no auth, and sent mail as `security@scani.xyz`.
 *
 * The assertion is EVERY procedure in those two routers, enumerated from
 * the routers themselves rather than listed by hand. A hand-written list
 * of nine is a list that a tenth procedure is added beside — and the tenth
 * would be written by someone who had no reason to read this file. It
 * fails on a new `bearerProcedure` under `storage.` or `email.` without
 * anybody remembering this rule exists.
 *
 * Two controls, because one axis is half a check:
 *   - must-be-FOUND: the same calls REACH the resolver on an internal ctx,
 *     so the refusals below are the gate and not a broken caller.
 *   - must-be-ABSENT: the 16 product procedures a Cloud API customer is
 *     buying stay open to that same customer ctx, so the gate has not
 *     over-matched into the surface it is meant to leave alone.
 */

import { describe, expect, test } from 'bun:test';
import type { AnyRouter } from '@trpc/server';
import { emailRouter } from '../../src/presentation/routers/email';
import { pricingRouter } from '../../src/presentation/routers/pricing';
import { storageRouter } from '../../src/presentation/routers/storage';
import { buildAuthedContext, buildCustomerContext } from '../helpers/test-context';

function procedureNames(r: AnyRouter): string[] {
  return Object.keys(
    (r as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures
  );
}

const INTERNAL_ROUTERS: [string, AnyRouter][] = [
  ['storage', storageRouter],
  ['email', emailRouter],
];

// The denominator, asserted rather than assumed: a run that enumerated
// nothing would report zero refusals and read exactly like a clean pass.
const INTERNAL_PROCEDURES = INTERNAL_ROUTERS.flatMap(([ns, r]) =>
  procedureNames(r).map((name) => [`${ns}.${name}`, r, name] as const)
);

describe('the internal facades refuse a customer key (SC-585)', () => {
  test('there are procedures to check at all', () => {
    expect(INTERNAL_PROCEDURES.length).toBe(9);
  });

  for (const [path, router, name] of INTERNAL_PROCEDURES) {
    test(`${path} is FORBIDDEN for a non-internal caller`, async () => {
      const caller = router.createCaller(buildCustomerContext()) as Record<
        string,
        (input: unknown) => Promise<unknown>
      >;
      // `{}` is deliberately not a valid input for any of them. The gate
      // runs before zod, so a FORBIDDEN here proves the refusal is the
      // tier check — a BAD_REQUEST would mean the input was parsed first
      // and the caller got as far as the resolver's own validation.
      await expect(caller[name]?.({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  }

  // must-be-FOUND: without this, a caller that could not invoke ANYTHING
  // would pass every assertion above.
  for (const [path, router, name] of INTERNAL_PROCEDURES) {
    test(`${path} gets past the gate for an internal caller`, async () => {
      const caller = router.createCaller(buildAuthedContext()) as Record<
        string,
        (input: unknown) => Promise<unknown>
      >;
      // Same invalid `{}`. An internal caller reaches zod and is refused
      // by it — BAD_REQUEST, not FORBIDDEN. That is the gate opening.
      await expect(caller[name]?.({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  }

  // must-be-ABSENT: the gate must not have swallowed the product surface.
  test('a product procedure stays open to the same customer key', async () => {
    const caller = pricingRouter.createCaller(buildCustomerContext()) as Record<
      string,
      (input: unknown) => Promise<unknown>
    >;
    const names = procedureNames(pricingRouter);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      await expect(caller[name]?.({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});
