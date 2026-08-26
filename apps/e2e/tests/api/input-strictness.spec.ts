/**
 * SC-687 — the api refuses an undeclared parameter NESTED inside a payload,
 * asserted over the wire.
 *
 * SC-675 made every `.input()` schema strict and SC-682 closed a discriminated
 * union it walked past, but `.strict()` in zod marks ONE object and nothing
 * beneath it. `holdings.update` posts `{ id, data }`: the envelope refused
 * undeclared keys while `data` — which carries every parameter the endpoint
 * actually takes — went on silently stripping them. 50 objects across 20
 * endpoints were in that state, and the unit guard reported all of them clean
 * because its walk stopped at the outermost object.
 *
 * This lives in e2e rather than beside the unit guard on purpose. The unit
 * guard reads schemas out of the router; it cannot see the HTTP layer, the
 * tRPC input decoder, or the JSON round trip, and a refusal that never reaches
 * a real caller is not a refusal. `bun run test` does not run `apps/e2e`, so
 * nothing in the unit gate observes the wire's actual behaviour.
 *
 * BOTH AXES ARE HERE DELIBERATELY. The valid request is not decoration: an
 * assertion that a bad request 400s passes just as well against an endpoint
 * that rejects everything, and "the payload is now refused when it should not
 * be" is the exact way over-applying strictness would break production.
 */

import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';
import { createAccount, createHolding } from '../../fixtures/ui';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';
const HEADERS = { 'content-type': 'application/json', origin: ORIGIN };

interface TrpcErrorBody {
  error?: { message?: string };
}

test.describe('api: undeclared parameters are refused, at every depth', () => {
  test('a stray key inside `data` is refused, while the same payload without it succeeds', async ({
    page,
  }, testInfo) => {
    await signIn({ page, testInfo });
    const account = await createAccount(page, { name: `e2e-acct-${testInfo.testId}` });
    const holding = await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: '1000',
    });

    // CONTROL. `editCause` is required on a fiat balance edit (SC-510); this is
    // the payload the app itself sends. If this ever fails, the strictness has
    // been over-applied and the assertion below means nothing.
    const good = await page.request.post(`${API_BASE_URL}/trpc/holdings.update`, {
      data: { id: holding.id, data: { balance: '1500', editCause: 'flow' } },
      headers: HEADERS,
    });
    expect(good.ok()).toBe(true);

    // THE INJECTION. Byte-for-byte the request above with ONE undeclared key
    // added INSIDE `data`. Before SC-687 this returned 200 and silently
    // dropped the key, which is the failure the ticket exists for: the caller
    // is told the request it typed succeeded.
    const nested = await page.request.post(`${API_BASE_URL}/trpc/holdings.update`, {
      data: {
        id: holding.id,
        data: { balance: '1600', editCause: 'flow', zzUndeclaredNested: 'x' },
      },
      headers: HEADERS,
    });
    expect(nested.status()).toBe(400);
    const nestedBody = (await nested.json()) as TrpcErrorBody;
    expect(nestedBody.error?.message).toContain('unrecognized_keys');
    // Naming the key is what makes the refusal actionable rather than a blank
    // 400 the caller has to guess at.
    expect(nestedBody.error?.message).toContain('zzUndeclaredNested');

    // The envelope was already strict before SC-687. Asserted alongside so a
    // regression tells you WHICH depth broke rather than only that one did.
    const envelope = await page.request.post(`${API_BASE_URL}/trpc/holdings.update`, {
      data: {
        id: holding.id,
        data: { balance: '1600', editCause: 'flow' },
        zzUndeclaredTopLevel: 'x',
      },
      headers: HEADERS,
    });
    expect(envelope.status()).toBe(400);
    const envelopeBody = (await envelope.json()) as TrpcErrorBody;
    expect(envelopeBody.error?.message).toContain('zzUndeclaredTopLevel');

    // And the refusals changed nothing: the control's write stands, neither
    // rejected request was half-applied.
    const listRes = await page.request.get(
      `${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`
    );
    const list = (await listRes.json()) as {
      result: { data: { holdings: { id: string; amount: string }[] } };
    };
    expect(list.result.data.holdings.find((h) => h.id === holding.id)?.amount).toBe('1500');
  });
});
