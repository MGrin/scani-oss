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
import { buildAuthedContext } from '../../helpers/test-context';

function caller() {
  return keysRouter.createCaller({
    ...buildAuthedContext(),
    cloudUser: { id: 'user-1', email: 'someone@example.com', name: null },
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
