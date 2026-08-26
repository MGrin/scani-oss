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
 */
export function strictInput<T extends z.ZodTypeAny>(schema: T): T {
  return strictify(schema) as T;
}

/**
 * The wrapper kinds this understands, named so the list is checkable.
 *
 * A helper that silently no-ops on a shape it does not recognise is a fragment
 * vouching for a passage: the call site reads as protected and is not, and
 * nothing distinguishes it from one that is (SC-671). So the kinds are
 * enumerated here and `strict-input.test.ts` asserts that every schema kind
 * actually reaching `.input()` in this app is one of them — an unhandled
 * wrapper fails the gate rather than passing quietly.
 */
export const HANDLED_WRAPPERS = ['ZodDefault', 'ZodOptional', 'ZodNullable'] as const;

function strictify(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) return schema.strict();

  // A default/optional/nullable wrapper hides the object one level down.
  // `listAnswered` is `z.object({...}).default({})`, so this is not an edge
  // case — it is the endpoint the ticket was filed on.
  if (schema instanceof z.ZodDefault) {
    const inner = strictify(schema._def.innerType);
    return inner.default(schema._def.defaultValue());
  }
  if (schema instanceof z.ZodOptional) return strictify(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return strictify(schema.unwrap()).nullable();

  // Unions carry several objects and each has to refuse on its own.
  if (schema instanceof z.ZodUnion) {
    const options = schema._def.options.map((o: z.ZodTypeAny) => strictify(o));
    return z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  // A DISCRIMINATED union is a separate zod class, not a `ZodUnion` subclass,
  // so the branch above does not reach it and `instanceof z.ZodUnion` is
  // `false` for one. It was the single input in the router this helper walked
  // straight past (SC-682) — see the note on `isStrictifiable` for why nothing
  // said so.
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

  // Everything else — `z.string()`, `z.array()`, `z.void()` — has no unknown
  // keys to reject, so passing it through is the whole correct behaviour
  // rather than a gap. `isStrictifiable` is what tells the two apart.
  return schema;
}

/**
 * Whether `strictInput` can actually make this schema refuse unknown keys.
 *
 * `false` is not a failure: a `z.string()` input has no keys. It exists so a
 * test can assert that every OBJECT-shaped input in this app is reached,
 * without that assertion having to re-implement the walk above.
 *
 * **`false` IS THE DANGEROUS ANSWER, AND SC-682 IS WHY.** "Has no keys" and
 * "has keys this walk cannot see" are different facts that arrive here as the
 * same `false`, and only the first is benign. Every branch below decides the
 * question by looking for `ZodObject`, an `innerType`, or `ZodUnion`. A
 * `ZodDiscriminatedUnion` carries `options` and none of those three, so it
 * decoded as a leaf with nothing to guard — and `users.setObservedBurnAnswer`,
 * the one discriminated union among the router's 130 inputs, accepted
 * undeclared keys while all three of this module's tests reported it clean.
 *
 * So a shape that is not enumerated here does not fail loudly; it reads as
 * `z.string()`. When you add a schema kind to `strictify`, add it here in the
 * same edit, and add the router-level assertion that would have gone red.
 */
export function isStrictifiable(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodObject) return true;
  if (schema instanceof z.ZodDefault) return isStrictifiable(schema._def.innerType);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return isStrictifiable(schema.unwrap());
  }
  if (schema instanceof z.ZodUnion) {
    return schema._def.options.some((o: z.ZodTypeAny) => isStrictifiable(o));
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return schema._def.options.some((o: z.ZodTypeAny) => isStrictifiable(o));
  }
  return false;
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
