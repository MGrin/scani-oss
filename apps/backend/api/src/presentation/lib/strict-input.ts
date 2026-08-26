import { z } from 'zod';

/**
 * Make a procedure's input schema REFUSE keys it does not declare (SC-675).
 *
 * zod strips unknown keys by default, so a caller guessing a parameter name
 * gets a normal-looking answer to a request that was never valid. Measured on
 * production 2026-08-26: `transferReview.listAnswered` accepted `offset`,
 * `answerSource`, `sort` and `order` and ignored all four. Looping
 * `offset` over 0/100/200/300 pushed 400 rows into a Set that ended up
 * holding **100** — four copies of page one, every response HTTP 200 and
 * well-formed.
 *
 * A zero or a duplicate is worse than an error, because it READS AS A FINDING.
 * That one cost a wrong conclusion the same day: the rows SC-673 was written
 * for sit below the first page, `offset` appeared to page and did not, and
 * "those rows are unreachable through any surface, so the fix is unverifiable"
 * was reported to two threads and nearly accepted as a standing residual
 * against a shipped fix. Both halves were false. An error on the unknown key
 * would have cost one retry.
 *
 * WHY THIS WRAPS AT THE ROUTER BOUNDARY rather than `.strict()` on the schemas.
 * 27 of the api's input schemas are DTOs imported from `@scani/shared`, the
 * wire-contract package the frontends also use — `IdInputDto` alone is 10 of
 * them. Calling `.strict()` there changes what those DTOs mean everywhere they
 * are used, which is a much larger blast radius than the question being asked.
 * Applied here, the shared package is untouched and the refusal is exactly at
 * the boundary where a caller's guess arrives.
 *
 * A REFUSAL, NEVER A DEFAULT AND NEVER A CLAMP (mgrin, 2026-08-26). The same
 * reasoning as SC-670's unresolvable ref: silently substituting something
 * plausible leaves the caller believing they asked for what they typed. Note
 * that out-of-range VALUES already refuse — `limit: 5000` is a zod `too_big`
 * on both endpoints, measured live — so nothing here needs to add a clamp or
 * remove one. Unknown KEYS were the only gap.
 *
 * `.strict()` IS NOT RECURSIVE, AND THAT IS THE HALF SC-675 SHIPPED WITHOUT
 * (SC-687). It marks the object you call it on and nothing beneath it. So the
 * first version of this helper made `holdings.update`'s envelope strict while
 * `input.data` — the object holding every parameter the endpoint actually
 * takes — went on stripping silently. Measured on `df4384d5a`: 50 permissive
 * objects across 20 endpoints, of which 42 were nested. The headline "every
 * api procedure refuses parameters it does not declare" was true of the
 * envelope and false of the payload, on exactly the endpoints where the
 * payload is the whole request. `strictify` now descends into object shapes.
 */
export function strictInput<T extends z.ZodTypeAny>(schema: T): T {
  return strictify(schema) as T;
}

/**
 * Kinds with no keys anywhere beneath them. THE LIST THAT DOES NOT GROW.
 *
 * SC-682 taught this module that a walk which recognises CONTAINERS by name
 * treats an unlisted container as a leaf and reports it clean. The fix at the
 * time was to recognise containers by their child FIELD name instead —
 * `innerType` or `options` — which is the same predicate wearing different
 * clothes, and it left `ZodEffects` (child under `schema`) and `ZodArray`
 * (child under `type`) reading as leaves. Seven `.refine()`d inputs and one
 * array of objects went straight through (SC-687).
 *
 * So the enumeration is inverted: this names the LEAVES, and anything not on
 * it is treated as a container that `strictify` must know how to descend.
 * Leaf kinds are a closed, small, stable set — zod is not going to add a new
 * primitive — whereas container kinds are open-ended. An unrecognised kind
 * throws rather than passing quietly, so a schema shape nobody has taught this
 * module about fails when the router is CONSTRUCTED, which is at boot and in
 * every test run, rather than becoming a permissive endpoint nothing reports.
 */
const LEAF_KINDS: ReadonlySet<string> = new Set([
  'ZodString',
  'ZodNumber',
  'ZodBigInt',
  'ZodBoolean',
  'ZodDate',
  'ZodSymbol',
  'ZodUndefined',
  'ZodNull',
  'ZodVoid',
  'ZodAny',
  'ZodUnknown',
  'ZodNever',
  'ZodNaN',
  'ZodLiteral',
  'ZodEnum',
  'ZodNativeEnum',
]);

/** Kept exported so the router-level guard can assert this list is honest. */
export const STRICT_INPUT_LEAF_KINDS = LEAF_KINDS;

/** Raised when an input carries a shape this module has not been taught. */
export class UnknownSchemaKindError extends Error {
  constructor(readonly kind: string) {
    super(
      `strictInput: unhandled zod kind "${kind}". It is neither a known leaf ` +
        'nor a container this module can descend. Add it to strictify() (and ' +
        'to LEAF_KINDS if it genuinely has no keys beneath it) — do not let it ' +
        'through, because an unhandled container reaches .input() permissive ' +
        'while every guard reports clean (SC-682, SC-687).'
    );
    this.name = 'UnknownSchemaKindError';
  }
}

function kindOf(schema: z.ZodTypeAny): string {
  return String((schema as unknown as { _def: { typeName?: unknown } })._def?.typeName);
}

function strictify(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape() as Record<string, z.ZodTypeAny>;
    const next: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(shape)) next[key] = strictify(value);
    // `.strict()` unconditionally, INCLUDING over a `.catchall()`. An earlier
    // draft exempted catchall objects, reasoning that a catchall declares
    // unknown keys are expected and that forcing strict would refuse input the
    // author allowed. Measured on zod 3.25.76: a catchall takes precedence
    // over `unknownKeys` at parse time, so `.strict()` sets the flag and
    // changes no behaviour at all — `{a:1, x:'ok'}` is still accepted and
    // `{a:1, x:99}` is still refused. The exemption was a branch that could
    // not be observed, over a case no input in this router has.
    return new z.ZodObject({ ...schema._def, shape: () => next }).strict();
  }

  // A default/optional/nullable wrapper hides its subject one level down.
  // `listAnswered` is `z.object({...}).default({})`, so this is not an edge
  // case — it is the endpoint SC-675 was filed on. Rebuilt through the
  // constructor rather than through `.default()` / `.optional()` so nothing
  // else in the def (description, error map, the default THUNK) is dropped.
  if (schema instanceof z.ZodDefault) {
    return new z.ZodDefault({ ...schema._def, innerType: strictify(schema._def.innerType) });
  }
  if (schema instanceof z.ZodOptional) {
    return new z.ZodOptional({ ...schema._def, innerType: strictify(schema._def.innerType) });
  }
  if (schema instanceof z.ZodNullable) {
    return new z.ZodNullable({ ...schema._def, innerType: strictify(schema._def.innerType) });
  }

  // Unions carry several objects and each has to refuse on its own.
  if (schema instanceof z.ZodUnion) {
    const options = schema._def.options.map((o: z.ZodTypeAny) => strictify(o));
    return new z.ZodUnion({ ...schema._def, options });
  }

  // A DISCRIMINATED union is a separate zod class, not a `ZodUnion` subclass,
  // so the branch above does not reach it and `instanceof z.ZodUnion` is
  // `false` for one. It was the single input in the router the first version
  // of this helper walked straight past (SC-682).
  //
  // Rebuilt through `z.discriminatedUnion` rather than by mutating options, so
  // the discriminator map zod builds at construction is derived from the strict
  // objects rather than left pointing at the permissive ones.
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema._def.options.map((o: z.ZodTypeAny) => strictify(o));
    return z.discriminatedUnion(
      schema._def.discriminator,
      options as unknown as [
        z.ZodDiscriminatedUnionOption<string>,
        ...z.ZodDiscriminatedUnionOption<string>[],
      ]
    );
  }

  // `.refine()` and `.transform()` both produce a ZodEffects whose subject is
  // under `schema`, not `innerType` — which is why the SC-682 walk called it a
  // leaf. Seven of the router's inputs are refined objects (SC-687).
  if (schema instanceof z.ZodEffects) {
    return new z.ZodEffects({ ...schema._def, schema: strictify(schema._def.schema) });
  }

  // An array of objects: the ELEMENTS are where the undeclared key lands.
  if (schema instanceof z.ZodArray) {
    return new z.ZodArray({ ...schema._def, type: strictify(schema._def.type) });
  }

  if (schema instanceof z.ZodRecord) {
    return new z.ZodRecord({ ...schema._def, valueType: strictify(schema._def.valueType) });
  }

  if (schema instanceof z.ZodTuple) {
    const items = schema._def.items.map((o: z.ZodTypeAny) => strictify(o));
    return new z.ZodTuple({ ...schema._def, items });
  }

  if (schema instanceof z.ZodLazy) {
    const getter = schema._def.getter;
    return new z.ZodLazy({ ...schema._def, getter: () => strictify(getter()) });
  }

  if (schema instanceof z.ZodPipeline) {
    return new z.ZodPipeline({
      ...schema._def,
      in: strictify(schema._def.in),
      out: strictify(schema._def.out),
    });
  }

  if (schema instanceof z.ZodIntersection) {
    return new z.ZodIntersection({
      ...schema._def,
      left: strictify(schema._def.left),
      right: strictify(schema._def.right),
    });
  }

  if (schema instanceof z.ZodBranded) {
    return new z.ZodBranded({ ...schema._def, type: strictify(schema._def.type) });
  }

  if (schema instanceof z.ZodReadonly) {
    return new z.ZodReadonly({ ...schema._def, innerType: strictify(schema._def.innerType) });
  }

  if (schema instanceof z.ZodCatch) {
    return new z.ZodCatch({ ...schema._def, innerType: strictify(schema._def.innerType) });
  }

  if (schema instanceof z.ZodPromise) {
    return new z.ZodPromise({ ...schema._def, type: strictify(schema._def.type) });
  }

  const kind = kindOf(schema);
  if (LEAF_KINDS.has(kind)) return schema;

  // NOT a silent pass-through. See LEAF_KINDS.
  throw new UnknownSchemaKindError(kind);
}

/**
 * Whether `strictInput` can actually make this schema refuse unknown keys.
 *
 * `false` is not a failure: a `z.string()` input has no keys. It exists so a
 * test can assert that every OBJECT-shaped input in this app is reached,
 * without that assertion having to re-implement the walk above.
 *
 * **`false` USED TO BE THE DANGEROUS ANSWER, AND SC-682 IS WHY.** "Has no
 * keys" and "has keys this walk cannot see" were different facts arriving here
 * as the same `false`, and only the first is benign. Every branch decided the
 * question by looking for `ZodObject`, an `innerType`, or `ZodUnion`, so a
 * `ZodDiscriminatedUnion` decoded as a leaf with nothing to guard — and
 * `users.setObservedBurnAnswer` accepted undeclared keys while all three of
 * this module's tests reported it clean.
 *
 * It is answered by `strictify` itself now, so the two facts cannot diverge:
 * an unknown kind throws there rather than being reported `false` here.
 */
export function isStrictifiable(schema: z.ZodTypeAny): boolean {
  return !LEAF_KINDS.has(kindOf(schema));
}

/**
 * The keys a `strictInput` refusal named, or `null` if this is any other error.
 *
 * Lives beside the refusal it reads. A guard whose first real firing is
 * invisible is the shape SC-675 exists to remove, and this one would have been
 * born with it: `isExpectedClientError` skips every 4xx before Sentry — for a
 * good reason, so real server errors are not drowned by ordinary client faults
 * — and an `unrecognized_keys` refusal is a `BAD_REQUEST`.
 *
 * It does not belong in that class. An ordinary 4xx is a caller doing
 * something we correctly refuse. This one says a caller believes it is sending
 * a parameter we do not accept, which is either our own client with a bug or a
 * stale bundle mid-deploy — the one residual a grep over this repo cannot
 * close. Both are things we want to learn from a signal rather than from a
 * user. It is bounded, too: it can only fire on a key no schema declares.
 */
export function unrecognizedKeysFrom(error: unknown): string[] | null {
  const cause = (error as { cause?: unknown })?.cause;
  const issues = (cause as { issues?: unknown })?.issues;
  if (!Array.isArray(issues)) return null;
  const keys = issues
    .filter((i): i is { code: string; keys: string[] } => {
      const issue = i as { code?: unknown; keys?: unknown };
      return issue.code === 'unrecognized_keys' && Array.isArray(issue.keys);
    })
    .flatMap((i) => i.keys)
    .filter((k): k is string => typeof k === 'string');
  return keys.length > 0 ? keys : null;
}
