/**
 * SC-675 — the guard that stops the permissive default growing back.
 *
 * Fixing 130 `.input()` sites and fixing the thing that made 130 sites
 * permissive are different jobs, and only the second survives the next
 * procedure somebody adds. zod strips unknown keys by DEFAULT, so a new
 * `.input(z.object({...}))` written next month is silently permissive again
 * and looks exactly like the 130 that are not.
 *
 * So the assertion below walks the REAL `appRouter` rather than grepping the
 * source: it reads every procedure's input parser out of tRPC and fails when
 * one can be handed a key it does not declare.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  HANDLED_WRAPPERS,
  isStrictifiable,
  strictInput,
  unrecognizedKeysFrom,
} from '../../../src/presentation/lib/strict-input';
import { appRouter } from '../../../src/presentation/router';

type AnyDef = { typeName?: string; unknownKeys?: string; innerType?: unknown; options?: unknown[] };
const defOf = (schema: unknown): AnyDef => (schema as { _def?: AnyDef })?._def ?? {};

/** Every `(path, inputSchema)` pair the router actually holds. */
function routerInputs(): Array<{ path: string; schema: unknown }> {
  const procedures = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })
    ._def.procedures;
  const out: Array<{ path: string; schema: unknown }> = [];
  for (const [path, procedure] of Object.entries(procedures)) {
    const inputs = (procedure as { _def?: { inputs?: unknown[] } })._def?.inputs;
    if (!Array.isArray(inputs)) continue;
    for (const schema of inputs) out.push({ path, schema });
  }
  return out;
}

/** Walk to the object under any wrapper this helper claims to handle. */
function permissiveObjectUnder(schema: unknown): boolean {
  const def = defOf(schema);
  if (def.typeName === 'ZodObject') return def.unknownKeys !== 'strict';
  if (
    def.typeName === 'ZodDefault' ||
    def.typeName === 'ZodOptional' ||
    def.typeName === 'ZodNullable'
  ) {
    return permissiveObjectUnder(def.innerType);
  }
  if (def.typeName === 'ZodUnion') return (def.options ?? []).some(permissiveObjectUnder);
  return false;
}

describe('every api procedure refuses parameters it does not declare (SC-675)', () => {
  const inputs = routerInputs();

  /**
   * THE CONTROL, AND THE TEST TO READ BEFORE TRUSTING THE ONE BELOW IT.
   *
   * A walk that finds nothing and a walk that runs over an empty list read
   * identically. If `_def.procedures` or `_def.inputs` is ever renamed by a
   * tRPC upgrade, `routerInputs()` returns `[]` and the strictness assertion
   * passes over a router it never looked at.
   */
  test('the walk actually reaches the router', () => {
    expect(inputs.length).toBeGreaterThan(100);
    expect(inputs.some((i) => i.path === 'transferReview.listAnswered')).toBe(true);
    expect(inputs.some((i) => i.path === 'transactions.list')).toBe(true);
  });

  test('no input schema accepts an undeclared key', () => {
    const permissive = inputs.filter((i) => permissiveObjectUnder(i.schema)).map((i) => i.path);
    expect(permissive).toEqual([]);
  });

  /**
   * SC-671's lesson, applied before it can bite: a helper that silently
   * no-ops on a shape it does not recognise is a fragment vouching for a
   * passage — the call site reads as protected and is not. So the wrapper
   * kinds are enumerated, and a new one appearing in the router fails HERE
   * rather than passing quietly at the boundary it was supposed to guard.
   */
  test('every wrapper kind in the router is one this helper handles', () => {
    const wrappers = new Set<string>();
    const walk = (schema: unknown) => {
      const def = defOf(schema);
      const name = def.typeName;
      if (!name || name === 'ZodObject') return;
      if (name === 'ZodUnion') {
        for (const o of def.options ?? []) walk(o);
        return;
      }
      if (def.innerType === undefined) return; // a leaf: z.string(), z.array(), …
      wrappers.add(name);
      walk(def.innerType);
    };
    for (const { schema } of inputs) walk(schema);
    const unhandled = [...wrappers].filter(
      (w) => !(HANDLED_WRAPPERS as readonly string[]).includes(w)
    );
    expect(unhandled).toEqual([]);
  });
});

describe('strictInput', () => {
  test('a plain object refuses an undeclared key and keeps accepting declared ones', () => {
    const schema = strictInput(z.object({ limit: z.number() }));
    expect(schema.safeParse({ limit: 1 }).success).toBe(true);
    const bad = schema.safeParse({ limit: 1, offset: 100 });
    expect(bad.success).toBe(false);
    expect(bad.success === false && bad.error.issues[0]?.code).toBe('unrecognized_keys');
  });

  /**
   * `listAnswered` is `z.object({...}).default({})`, so the object is one
   * level down. This is the endpoint the ticket was filed on — not an edge
   * case — and a helper that only understood bare objects would have left it
   * exactly as permissive while reading as fixed.
   */
  test('a default wrapper is unwrapped, made strict, and keeps its default', () => {
    const schema = strictInput(z.object({ limit: z.number().default(25) }).default({}));
    expect(schema.parse(undefined)).toEqual({ limit: 25 });
    expect(schema.safeParse({ offset: 100 }).success).toBe(false);
  });

  test('optional and nullable wrappers keep their own behaviour', () => {
    const opt = strictInput(z.object({ a: z.number() }).optional());
    expect(opt.parse(undefined)).toBeUndefined();
    expect(opt.safeParse({ a: 1, b: 2 }).success).toBe(false);

    const nul = strictInput(z.object({ a: z.number() }).nullable());
    expect(nul.parse(null)).toBeNull();
    expect(nul.safeParse({ a: 1, b: 2 }).success).toBe(false);
  });

  test('every branch of a union refuses on its own', () => {
    const schema = strictInput(z.union([z.object({ a: z.number() }), z.object({ b: z.number() })]));
    expect(schema.safeParse({ a: 1 }).success).toBe(true);
    expect(schema.safeParse({ b: 1 }).success).toBe(true);
    expect(schema.safeParse({ b: 1, c: 3 }).success).toBe(false);
  });

  /**
   * Passing a non-object through is the whole correct behaviour, not a gap —
   * `z.string()` has no keys to reject. `isStrictifiable` is what lets a test
   * tell that apart from a shape the walk failed to reach.
   */
  test('a non-object passes through unchanged and reports itself as such', () => {
    expect(strictInput(z.string()).parse('x')).toBe('x');
    expect(isStrictifiable(z.string())).toBe(false);
    expect(isStrictifiable(z.object({}))).toBe(true);
    expect(isStrictifiable(z.object({}).default({}))).toBe(true);
    expect(isStrictifiable(z.union([z.object({}), z.string()]))).toBe(true);
  });

  test('the declared values a schema already refuses are untouched', () => {
    // `limit: 5000` was reported as returning zero rows; it does not, and it
    // never did — out-of-range VALUES already refuse. Nothing here adds a
    // clamp, and nothing here removes one.
    const schema = strictInput(z.object({ limit: z.number().int().max(500) }));
    const tooBig = schema.safeParse({ limit: 5000 });
    expect(tooBig.success).toBe(false);
    expect(tooBig.success === false && tooBig.error.issues[0]?.code).toBe('too_big');
  });
});

describe('unrecognizedKeysFrom', () => {
  test('names the keys of a strictInput refusal', () => {
    const result = strictInput(z.object({ limit: z.number() })).safeParse({ limit: 1, offset: 2 });
    const error = result.success ? null : { cause: result.error };
    expect(unrecognizedKeysFrom(error)).toEqual(['offset']);
  });

  test('is null for every other error, so the Sentry path stays narrow', () => {
    const tooBig = strictInput(z.object({ limit: z.number().max(1) })).safeParse({ limit: 9 });
    expect(unrecognizedKeysFrom(tooBig.success ? null : { cause: tooBig.error })).toBeNull();
    expect(unrecognizedKeysFrom(new Error('boom'))).toBeNull();
    expect(unrecognizedKeysFrom(null)).toBeNull();
    expect(unrecognizedKeysFrom({ cause: { issues: 'not an array' } })).toBeNull();
  });

  /**
   * The `code` check is what makes this narrow, and nothing real exercises it
   * today: `unrecognized_keys` is the only zod issue that carries a `keys`
   * array, so a shape check alone happens to agree on every current input.
   * A mutation dropping the code check survived every other test here.
   *
   * It is worth pinning rather than deleting: the whole argument for routing
   * this ONE 4xx to Sentry is that it cannot fire on ordinary client faults,
   * and that argument is about the code, not about the shape. A future zod
   * issue type carrying `keys` would widen the channel silently.
   */
  test('an issue carrying keys under a different code is not one of ours', () => {
    const foreign = { cause: { issues: [{ code: 'some_future_code', keys: ['x'] }] } };
    expect(unrecognizedKeysFrom(foreign)).toBeNull();
  });
});
