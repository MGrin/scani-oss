/**
 * The canonical email check, as a predicate rather than as a schema.
 *
 * `emailSchema` is built from this rather than from `z.string().email()`, and
 * the reason is a measurement: zod is **60 KB minified / 13 KB brotli** and the
 * sign-in form was the only thing in the eager bundle reaching for it (SC-169).
 * That is 13 KB every cold visitor downloads before anything renders, spent on
 * validating one text field. Importing this module instead of `./index` keeps
 * zod behind the UI-generation split, where it is already being downloaded for
 * the DTOs.
 *
 * One pattern, two callers — the form and the schema — so the rule cannot drift
 * between the two the way a re-typed regex would.
 */

/**
 * Local part, `@`, domain, dot, TLD — with no whitespace anywhere and a TLD of
 * at least two characters.
 *
 * Deliberately not RFC 5322. The only thing this decides is whether to bother
 * the API with an address, and the API's own verification is what actually
 * settles it: a magic link nobody can receive is the real rejection. A stricter
 * pattern here buys nothing and turns a legitimate-but-unusual address into a
 * form that will not submit, with no way past it.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * WHY `value` is unacceptable, or `undefined` when it is fine.
 *
 * Split out from `emailError` because this package has no `t()` and cannot get
 * one — it is the wire contract, and the api and worker import it (SC-405).
 * The English below is therefore the right answer for a server response and the
 * wrong one for a screen, and the sign-in form is a screen: it rendered
 * "Please enter a valid email address" under an otherwise fully Russian page,
 * on the first screen a new reader ever sees. A caller that HAS a `t()` takes
 * the reason and names it itself.
 */
export type EmailErrorReason = 'required' | 'invalid';

export function emailErrorReason(value: string): EmailErrorReason | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'required';
  if (!EMAIL_PATTERN.test(trimmed)) return 'invalid';
  return undefined;
}

/**
 * The message to show for `value`, or `undefined` when it is acceptable.
 *
 * Returns the message rather than a boolean because both callers need the text
 * and the two messages are not interchangeable: "Email is required" belongs to
 * an untouched field, "Please enter a valid email address" to a typo.
 */
export function emailError(value: string): string | undefined {
  switch (emailErrorReason(value)) {
    case 'required':
      return 'Email is required';
    case 'invalid':
      return 'Please enter a valid email address';
    default:
      return undefined;
  }
}
