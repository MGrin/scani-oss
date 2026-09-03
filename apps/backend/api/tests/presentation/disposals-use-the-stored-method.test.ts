import { describe, expect, test } from 'bun:test';
import { appRouter } from '../../src/presentation/router';

/**
 * SC-957 — `portfolio.getDisposals` computes under the account's STORED
 * cost-basis method, and there is no way to ask it for another one.
 *
 * ## Why this guard exists
 *
 * The input carried an optional `costBasisMethod` that won over
 * `users.cost_basis_method`, so a caller could be handed realized figures
 * computed under a rule the user never selected and that nothing recorded.
 * mgrin decided on 2026-09-03 that the method stays freely changeable *with a
 * recorded history* — and an override defeats that by construction, because
 * the method it computes under is never stored, so no history row can explain
 * the figure it produced. A history table with that hole in it on day one is
 * not a mechanism.
 *
 * ## Why it asserts against the REAL router and not against the source text
 *
 * A grep for `costBasisMethod` in `portfolio.ts` passes the moment the literal
 * moves — into a shared DTO, into a spread, into a variable — while the
 * endpoint goes on accepting it. What is actually being pinned is that the
 * schema tRPC will parse a request with REFUSES the key, so that is what is
 * parsed here.
 *
 * ## The control
 *
 * `from` and `to` must be ACCEPTED by the same schema in the same test. Without
 * it, a schema that refused everything — a wrong path, a renamed procedure, an
 * input that is no longer an object — would satisfy the refusal assertion and
 * report this guard green while measuring nothing.
 */

function inputSchemaFor(path: string): { safeParse: (v: unknown) => { success: boolean } } {
  const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
    ._def.procedures;
  const procedure = procedures[path];
  if (!procedure) throw new Error(`no such procedure: ${path}`);
  const inputs = (procedure as { _def?: { inputs?: unknown[] } })._def?.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw new Error(`${path} does not have exactly one input schema`);
  }
  return inputs[0] as { safeParse: (v: unknown) => { success: boolean } };
}

const WINDOW = {
  from: new Date('2024-01-01T00:00:00.000Z'),
  to: new Date('2024-12-31T00:00:00.000Z'),
};

describe('SC-957 — portfolio.getDisposals takes no cost-basis method', () => {
  const schema = inputSchemaFor('portfolio.getDisposals');

  // THE CONTROL. A schema that refuses everything would pass the next test.
  test('the window itself is accepted — so a refusal below means something', () => {
    expect(schema.safeParse(WINDOW).success).toBe(true);
  });

  test('a request naming a cost-basis method is REFUSED, not silently ignored', () => {
    // `strictInput` (SC-675) is what makes this a refusal rather than a strip:
    // a stripped key would let a caller believe it got what it asked for.
    expect(schema.safeParse({ ...WINDOW, costBasisMethod: 'uk_section_104' }).success).toBe(false);
    // Also refused when it AGREES with a plausible stored value — the point is
    // that the request cannot name the method at all, not that it cannot
    // disagree.
    expect(schema.safeParse({ ...WINDOW, costBasisMethod: 'fifo' }).success).toBe(false);
  });

  /**
   * The endpoint itself STAYS. Zero callers today and that is intended: its own
   * docblock scopes the window as two instants because the route encodes no
   * jurisdiction's idea of a year, written knowing the tax statement was
   * declined. Deliberate groundwork is not the dead code the no-stubs rule
   * targets, and knip cannot see it either way — a tRPC procedure is reachable
   * only through the router object.
   */
  test('the endpoint still exists', () => {
    expect(() => inputSchemaFor('portfolio.getDisposals')).not.toThrow();
  });
});
