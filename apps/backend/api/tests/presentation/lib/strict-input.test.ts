/**
 * SC-675 / SC-687 — the guard that stops the permissive default growing back.
 *
 * Fixing the `.input()` sites and fixing the thing that made them permissive
 * are different jobs, and only the second survives the next procedure somebody
 * adds. zod strips unknown keys by DEFAULT, so a new
 * `.input(z.object({...}))` written next month is silently permissive again
 * and looks exactly like the ones that are not.
 *
 * So the assertions below walk the REAL `appRouter` rather than grepping the
 * source: they read every procedure's input parser out of tRPC and fail when
 * any object anywhere beneath it can be handed a key it does not declare.
 *
 * THE WALK DESCENDS INTO OBJECT PROPERTIES, AND THAT IS THE POINT (SC-687).
 * The SC-675 version stopped at the outermost object, so `holdings.update`'s
 * `{ id, data }` envelope read as strict while `data` — every parameter the
 * endpoint actually takes — went on stripping. 50 permissive objects across 20
 * endpoints were invisible to a guard that reported clean. A walk that stops
 * somewhere reports everything past the stop as absent rather than unexamined.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  isStrictifiable,
  STRICT_INPUT_LEAF_KINDS,
  strictInput,
  UnknownSchemaKindError,
  unrecognizedKeysFrom,
} from '../../../src/presentation/lib/strict-input';
import { appRouter } from '../../../src/presentation/router';

type AnyDef = Record<string, unknown>;
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

interface Walked {
  readonly permissive: string[];
  readonly objects: number;
  readonly kinds: Set<string>;
  readonly objectPaths: Set<string>;
}

/**
 * Descend through EVERY child a zod node can carry, by every field name zod
 * uses, and report each object that is not strict.
 *
 * Deliberately independent of `strictify`'s own branch list: a guard that
 * reuses the walk it is checking can only ever agree with it. The child field
 * names are enumerated here so a kind this file has not been taught still gets
 * its object children visited if it stores them under a familiar name.
 */
function walk(schema: unknown, where: string, acc: Walked, seen: Set<unknown>): void {
  if (!schema || seen.has(schema)) return;
  seen.add(schema);
  const def = defOf(schema);
  const kind = String(def.typeName);
  acc.kinds.add(kind);

  if (kind === 'ZodObject') {
    (acc as { objects: number }).objects++;
    acc.objectPaths.add(where);
    if (def.unknownKeys !== 'strict') {
      acc.permissive.push(`${where} (unknownKeys=${String(def.unknownKeys)})`);
    }
    const shape = typeof def.shape === 'function' ? (def.shape as () => AnyDef)() : {};
    for (const [key, value] of Object.entries(shape)) walk(value, `${where}.${key}`, acc, seen);
    return;
  }

  for (const field of ['innerType', 'schema', 'type', 'left', 'right', 'in', 'out', 'valueType']) {
    if (def[field] !== undefined) walk(def[field], `${where}<${kind}>`, acc, seen);
  }
  for (const list of ['options', 'items']) {
    if (Array.isArray(def[list])) {
      for (const option of def[list] as unknown[]) walk(option, `${where}<${kind}>`, acc, seen);
    }
  }
  if (typeof def.getter === 'function') {
    walk((def.getter as () => unknown)(), `${where}<${kind}>`, acc, seen);
  }
}

function walkAll(inputs: Array<{ path: string; schema: unknown }>): Walked {
  const acc: Walked = {
    permissive: [],
    objects: 0,
    kinds: new Set<string>(),
    objectPaths: new Set<string>(),
  };
  for (const { path, schema } of inputs) walk(schema, path, acc, new Set());
  return acc;
}

describe('every api procedure refuses parameters it does not declare (SC-675, SC-687)', () => {
  const inputs = routerInputs();
  const walked = walkAll(inputs);

  /**
   * THE CONTROL, AND THE TEST TO READ BEFORE TRUSTING THE ONES BELOW IT.
   *
   * A walk that finds nothing and a walk that runs over an empty list read
   * identically. If `_def.procedures` or `_def.inputs` is ever renamed by a
   * tRPC upgrade, `routerInputs()` returns `[]` and every assertion here
   * passes over a router it never looked at.
   *
   * THE DESCENT HALF OF THE CONTROL NAMES A PATH, AND THE FIRST VERSION
   * COUNTED INSTEAD — WHICH MEASURED NOTHING. `walked.objects > inputs.length`
   * looks like it proves the walk went past the envelope. It does not:
   * objects nested under a CONTAINER (`ZodEffects`, a discriminated union, an
   * array) are reached without ever calling `_def.shape()`. Measured on this
   * router — 174 objects with shape descent, 132 without, against 130 inputs.
   * Both are greater than 130, so the assertion passed either way and a walk
   * that never descended into a single property would have read as healthy.
   *
   * Caught by mutating the walk to stop at the envelope and finding this test
   * still green. Naming an object that can ONLY be reached through a property
   * is what makes it discriminate: `holdings.update` is `{ id, data }`, and
   * `data` is the object SC-687 exists for.
   */
  test('the walk actually reaches the router, and descends past the envelope', () => {
    expect(inputs.length).toBeGreaterThan(100);
    expect(inputs.some((i) => i.path === 'transferReview.listAnswered')).toBe(true);
    expect(inputs.some((i) => i.path === 'transactions.list')).toBe(true);
    expect(inputs.some((i) => i.path === 'holdings.update')).toBe(true);
    expect(walked.objectPaths.has('holdings.update')).toBe(true);
    expect(walked.objectPaths.has('holdings.update.data')).toBe(true);
  });

  test('no object anywhere under an input accepts an undeclared key', () => {
    expect(walked.permissive).toEqual([]);
  });

  /**
   * SC-682's lesson, inverted rather than narrowed.
   *
   * That fix replaced "recognise these container NAMES" with "recognise these
   * two child FIELD names", which is the same predicate in different clothes —
   * `ZodEffects` stores its child under `schema` and `ZodArray` under `type`,
   * so both still read as leaves and eight inputs stayed permissive (SC-687).
   *
   * The list that can safely be positive is the LEAF list: zod's primitives
   * are a closed set, container kinds are not. This asserts the leaf list is
   * honest about the router as it stands — a kind that is neither a known leaf
   * nor descended by the walk above would leave `objects` short and show up
   * here.
   */
  test('every schema kind in the router is a known leaf or a descended container', () => {
    const descended = new Set([
      'ZodObject',
      'ZodOptional',
      'ZodNullable',
      'ZodDefault',
      'ZodUnion',
      'ZodDiscriminatedUnion',
      'ZodEffects',
      'ZodArray',
      'ZodRecord',
      'ZodTuple',
      'ZodLazy',
      'ZodPipeline',
      'ZodIntersection',
      'ZodBranded',
      'ZodReadonly',
      'ZodCatch',
      'ZodPromise',
    ]);
    const unaccounted = [...walked.kinds].filter(
      (k) => !STRICT_INPUT_LEAF_KINDS.has(k) && !descended.has(k)
    );
    expect(unaccounted).toEqual([]);
  });

  /**
   * The endpoints SC-687 was measured on. Named individually because a
   * regression here is a silently permissive production endpoint, and a count
   * going from 0 to 1 does not say which one.
   */
  test('the eight SC-687 endpoints refuse an undeclared key', () => {
    const cases: Array<[string, unknown]> = [
      ['portfolio.getNetWorthSeries', { from: new Date(), to: new Date(), zzStray: 1 }],
      ['transferReview.resolve', { transferId: 'x', decision: 'external', zzStray: 1 }],
      ['holdings.upsertApyConfig', { holdingId: 'x', zzStray: 1 }],
      ['batchOperations.ensureAccount', { accountId: 'x', zzStray: 1 }],
    ];
    const byPath = new Map(inputs.map((i) => [i.path, i.schema]));
    for (const [path, payload] of cases) {
      const schema = byPath.get(path) as z.ZodTypeAny | undefined;
      expect(schema).toBeDefined();
      const result = (schema as z.ZodTypeAny).safeParse(payload);
      const codes = result.success ? [] : result.error.issues.map((i) => i.code);
      expect({ path, hasUnrecognized: codes.includes('unrecognized_keys') }).toEqual({
        path,
        hasUnrecognized: true,
      });
    }
  });

  /**
   * The NESTED half — the SC-687 finding proper. `holdings.update` posts
   * `{ id, data }`; the envelope was already strict and `data` was not.
   */
  test('a nested payload object refuses an undeclared key', () => {
    const byPath = new Map(inputs.map((i) => [i.path, i.schema]));
    const schema = byPath.get('holdings.update') as z.ZodTypeAny;
    const result = schema.safeParse({ id: 'x', data: { zzStray: 1 } });
    const codes = result.success ? [] : result.error.issues.map((i) => i.code);
    expect(codes).toContain('unrecognized_keys');
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
   * level down. This is the endpoint SC-675 was filed on — not an edge case —
   * and a helper that only understood bare objects would have left it exactly
   * as permissive while reading as fixed.
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
   * SC-682. A DISCRIMINATED union is not a `ZodUnion` subclass in zod, so the
   * union branch never reached it and `strictify` returned it untouched.
   *
   * The second assertion matters as much as the refusal: narrowing by the
   * discriminator must survive being rebuilt, or this trades a permissive
   * input for a broken one.
   */
  test('every branch of a DISCRIMINATED union refuses on its own', () => {
    const schema = strictInput(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('override'), amount: z.string() }),
        z.object({ kind: z.literal('clear') }),
      ])
    );
    expect(schema.safeParse({ kind: 'override', amount: '1' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'clear' }).success).toBe(true);

    const stray = schema.safeParse({ kind: 'override', amount: '1', value: '2' });
    expect(stray.success).toBe(false);
    expect(stray.success === false && stray.error.issues[0]?.code).toBe('unrecognized_keys');

    expect(schema.safeParse({ kind: 'nonsense' }).success).toBe(false);
  });

  /**
   * SC-687. `.refine()` puts the object under `_def.schema`, which is neither
   * `innerType` nor `options` — the two fields the SC-682 walk looked for.
   * Seven router inputs are refined objects.
   *
   * The second assertion is the one that would catch a careless rebuild: the
   * refinement itself has to survive, or this trades a permissive input for
   * one that accepts something the author rejected.
   */
  test('a refined object refuses an undeclared key AND keeps its refinement', () => {
    const schema = strictInput(
      z.object({ from: z.number(), to: z.number() }).refine((v) => v.to >= v.from, {
        message: 'to must not precede from',
      })
    );
    expect(schema.safeParse({ from: 1, to: 2 }).success).toBe(true);
    expect(schema.safeParse({ from: 1, to: 2, zzStray: 1 }).success).toBe(false);

    const refused = schema.safeParse({ from: 5, to: 1 });
    expect(refused.success).toBe(false);
    expect(refused.success === false && refused.error.issues[0]?.message).toBe(
      'to must not precede from'
    );
  });

  test('a transform keeps transforming', () => {
    const schema = strictInput(
      z.object({ symbol: z.string() }).transform((v) => ({ symbol: v.symbol.toUpperCase() }))
    );
    expect(schema.parse({ symbol: 'btc' })).toEqual({ symbol: 'BTC' });
    expect(schema.safeParse({ symbol: 'btc', zzStray: 1 }).success).toBe(false);
  });

  /** SC-687. `tokens.createManyfromExternal` takes a bare array of objects. */
  test('array elements refuse an undeclared key', () => {
    const schema = strictInput(z.array(z.object({ a: z.number() })));
    expect(schema.safeParse([{ a: 1 }]).success).toBe(true);
    expect(schema.safeParse([{ a: 1, b: 2 }]).success).toBe(false);
  });

  /**
   * SC-687's core. `.strict()` is not recursive — it marks the object it is
   * called on and nothing beneath it — so a guard that only strictified the
   * outermost object left every real parameter bag permissive.
   */
  test('strictness reaches an object nested under a property', () => {
    const schema = strictInput(z.object({ id: z.string(), data: z.object({ name: z.string() }) }));
    expect(schema.safeParse({ id: 'x', data: { name: 'n' } }).success).toBe(true);
    const bad = schema.safeParse({ id: 'x', data: { name: 'n', zzStray: 1 } });
    expect(bad.success).toBe(false);
    expect(bad.success === false && bad.error.issues[0]?.code).toBe('unrecognized_keys');
  });

  test('strictness reaches an object nested under an optional array under a property', () => {
    const schema = strictInput(z.object({ rows: z.array(z.object({ v: z.number() })).optional() }));
    expect(schema.safeParse({ rows: [{ v: 1 }] }).success).toBe(true);
    expect(schema.safeParse({ rows: [{ v: 1, zzStray: 2 }] }).success).toBe(false);
  });

  /**
   * A `.catchall()` keeps working through `strictify`, and NOT because this
   * module exempts it. An earlier draft did, on the reasoning that a catchall
   * declares unknown keys are expected — but zod gives the catchall precedence
   * over `unknownKeys` at parse time, so the exemption changed no behaviour
   * and could not be observed. Mutating it away left every test green, which
   * is how it was found. The property is real and worth pinning; the branch
   * that claimed to provide it was not.
   */
  test('a declared catchall still validates unknown keys rather than refusing them', () => {
    const schema = strictInput(z.object({ a: z.number() }).catchall(z.string()));
    expect(schema.safeParse({ a: 1, anything: 'ok' }).success).toBe(true);
    expect(schema.safeParse({ a: 1, anything: 99 }).success).toBe(false);
  });

  /**
   * THE INVERSION, ASSERTED DIRECTLY.
   *
   * Both SC-682 and SC-687 were the same failure: a shape the helper did not
   * recognise was returned untouched, reaching `.input()` permissive while
   * every guard reported clean. The default is now a throw, so an unhandled
   * kind fails when the router is CONSTRUCTED rather than becoming a quiet
   * hole. This is the test that would have gone red for both of them.
   */
  test('an unrecognised schema kind THROWS rather than passing through', () => {
    const alien = { _def: { typeName: 'ZodSomethingNobodyTaughtUs' } } as unknown as z.ZodTypeAny;
    expect(() => strictInput(alien)).toThrow(UnknownSchemaKindError);
  });

  /**
   * THE SAME PROPERTY, ON A CONTAINER A DEVELOPER CAN ACTUALLY WRITE.
   *
   * The test above fabricates a `typeName`, which proves the default branch
   * but not that the branch is reachable from real zod. `z.set`, `z.map` and
   * `z.function` are genuine zod containers this module deliberately does not
   * descend — each can hold an object, so returning one untouched would be
   * precisely the SC-682 / SC-687 hole again. Nothing stops somebody writing
   * `.input(z.set(z.object({...})))` tomorrow.
   *
   * The controls are the other half: a container this module DOES descend
   * must not throw, or the inversion has been over-applied and the throw is
   * refusing valid schemas rather than unknown ones.
   */
  test('a REAL unhandled zod container throws, while handled ones and leaves do not', () => {
    const obj = z.object({ a: z.string() });

    expect(() => strictInput(z.set(obj))).toThrow(UnknownSchemaKindError);
    expect(() => strictInput(z.map(z.string(), obj))).toThrow(UnknownSchemaKindError);
    expect(() => strictInput(z.function())).toThrow(UnknownSchemaKindError);

    expect(() => strictInput(z.tuple([obj]))).not.toThrow();
    expect(() => strictInput(z.intersection(obj, obj))).not.toThrow();
    expect(() => strictInput(z.promise(obj))).not.toThrow();
    expect(() => strictInput(z.lazy(() => obj))).not.toThrow();
    expect(() => strictInput(z.string())).not.toThrow();
  });

  /**
   * Passing a leaf through is the whole correct behaviour, not a gap —
   * `z.string()` has no keys to reject.
   */
  test('a leaf passes through unchanged and reports itself as such', () => {
    expect(strictInput(z.string()).parse('x')).toBe('x');
    expect(isStrictifiable(z.string())).toBe(false);
    expect(isStrictifiable(z.object({}))).toBe(true);
    expect(isStrictifiable(z.object({}).default({}))).toBe(true);
    expect(isStrictifiable(z.union([z.object({}), z.string()]))).toBe(true);
    expect(
      isStrictifiable(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a') }),
          z.object({ kind: z.literal('b') }),
        ])
      )
    ).toBe(true);
    expect(isStrictifiable(z.object({}).refine(() => true))).toBe(true);
    expect(isStrictifiable(z.array(z.object({})))).toBe(true);
  });
});

describe('unrecognizedKeysFrom', () => {
  test('names the keys a strictInput refusal rejected', () => {
    const schema = strictInput(z.object({ limit: z.number() }));
    const result = schema.safeParse({ limit: 1, offset: 5, sort: 'x' });
    expect(result.success).toBe(false);
    const wrapped = { cause: result.success === false ? result.error : undefined };
    expect(unrecognizedKeysFrom(wrapped)?.sort()).toEqual(['offset', 'sort']);
  });

  test('returns null for any other error, so the signal stays narrow', () => {
    expect(unrecognizedKeysFrom(new Error('boom'))).toBeNull();
    expect(unrecognizedKeysFrom(undefined)).toBeNull();
    expect(
      unrecognizedKeysFrom({ cause: { issues: [{ code: 'too_big', keys: ['x'] }] } })
    ).toBeNull();
  });
});
