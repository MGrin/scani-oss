import { describe, expect, test } from 'bun:test';
import { appRouter } from '../../src/presentation/router';

/**
 * SC-980 — a signed-in reader can ASK which rule their figures were computed
 * under, and whether those figures are still being rewritten.
 *
 * Until this endpoint existed, `costBasisMethod` was write-only from a
 * browser's point of view: `updateCurrent` accepted it, `CurrentUserDto`
 * refused to hand it back, and no other procedure carried it. A control that
 * can set a value it cannot read is not a control — it is a form that guesses.
 *
 * ## Why the OUTPUT schema is what gets asserted
 *
 * tRPC's `.output()` is enforced by the server, so a field the schema does not
 * name cannot be served however the resolver changes, and a field it names but
 * the resolver stops returning fails there rather than arriving as `undefined`
 * on a screen. That makes the schema the contract, and the contract is the
 * thing a surface is entitled to rely on.
 *
 * `recomputingJobId` is the field to defend. Dropping it would leave `method`
 * and `lookbackDays` intact and every assertion about "the screen shows the
 * method" still passing, while the page silently lost its only way to say the
 * numbers are still moving — which is the exact failure the ticket names.
 *
 * ## The control
 *
 * A schema that refused everything would satisfy every refusal below while
 * measuring nothing, so a well-formed state must be ACCEPTED in the same test
 * file, and the procedure must exist at all.
 */

type ZodLike = { safeParse: (v: unknown) => { success: boolean } };

function outputSchemaFor(path: string): ZodLike {
  const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
    ._def.procedures;
  const procedure = procedures[path];
  if (!procedure) throw new Error(`no such procedure: ${path}`);
  const output = (procedure as { _def?: { output?: unknown } })._def?.output;
  if (!output) throw new Error(`${path} declares no output schema`);
  return output as ZodLike;
}

const VALID = { method: 'fifo', lookbackDays: 400, recomputingJobId: null };

describe('SC-980 — users.getCostBasisMethod answers the whole question', () => {
  const schema = outputSchemaFor('users.getCostBasisMethod');

  // THE CONTROL. Everything below is a refusal, and a schema that refused all
  // input would pass every one of them.
  test('a well-formed state is accepted', () => {
    expect(schema.safeParse(VALID).success).toBe(true);
    expect(schema.safeParse({ ...VALID, recomputingJobId: 'job-1' }).success).toBe(true);
  });

  test('a state that cannot say whether a rewrite is running is REFUSED', () => {
    const { recomputingJobId: _dropped, ...withoutJob } = VALID;
    expect(schema.safeParse(withoutJob).success).toBe(false);
  });

  test('a state that does not name the window a change rewrites is REFUSED', () => {
    const { lookbackDays: _dropped, ...withoutWindow } = VALID;
    expect(schema.safeParse(withoutWindow).success).toBe(false);
    // Nor a window of zero days, which would put "roughly 0 days of history"
    // in a confirmation about rewriting a year of it.
    expect(schema.safeParse({ ...VALID, lookbackDays: 0 }).success).toBe(false);
  });

  test('a method outside the two the walk implements is REFUSED', () => {
    expect(schema.safeParse({ ...VALID, method: 'lifo' }).success).toBe(false);
  });
});

describe('SC-980 — the write path the UI uses is still the one SC-957 made honest', () => {
  test('users.updateCurrent accepts a cost-basis method', () => {
    const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
      ._def.procedures;
    const inputs = (procedures['users.updateCurrent'] as { _def?: { inputs?: unknown[] } })._def
      ?.inputs;
    if (!Array.isArray(inputs) || inputs.length !== 1) {
      throw new Error('users.updateCurrent does not have exactly one input schema');
    }
    const input = inputs[0] as ZodLike;
    // The control sits inside this test on purpose: an input schema that
    // accepted anything would pass the line above, so a value the mutation
    // must REFUSE is checked against the same schema in the same breath.
    expect(input.safeParse({ costBasisMethod: 'uk_section_104' }).success).toBe(true);
    expect(input.safeParse({ costBasisMethod: 'lifo' }).success).toBe(false);
  });
});
