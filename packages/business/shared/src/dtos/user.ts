import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../decimal';
import { costBasisMethodSchema } from './cost-basis';

export const UpdateUserDto = z.object({
  name: z.string().min(1).optional(),
  avatar: z.string().url().nullable().optional(),
  baseCurrencyId: z.string().uuid().nullable().optional(),
  // Which matching rule the cost-basis walk uses for this account (SC-462).
  // Not nullable: the column is NOT NULL with a `fifo` default, and "no method"
  // is not a state any figure can be computed in.
  costBasisMethod: costBasisMethodSchema.optional(),
});

export type UpdateUserInput = z.infer<typeof UpdateUserDto>;

/**
 * What the user says about the MEASURED monthly drain (SC-661).
 *
 * ## Three intentions, and they are mutually exclusive by construction
 *
 * A discriminated union rather than a bag of optional fields, because the
 * database says the same thing and the two must not be able to disagree:
 * `users_observed_burn_one_answer` forbids holding an override and a
 * confirmation at once. Agreeing with a figure and replacing it are
 * contradictory answers to one question, and a row carrying both would give
 * the surface two authoritative answers to choose between — which is this
 * ticket's own defect, moved from two screens into one row.
 *
 * ## Why `confirm` carries a value at all
 *
 * It is not bookkeeping. The client sends back the figure it ACTUALLY SHOWED,
 * and that is the point: the drain is recomputed whenever the window moves, so
 * a confirmation recorded as a bare timestamp still reads as agreement when the
 * figure has moved underneath it. What is stored is **the amount that must
 * still match for the confirmation to mean anything**.
 *
 * `override` carries no such pairing, and the asymmetry is deliberate: it
 * replaces the figure rather than agreeing with it, so there is nothing left
 * for it to still match.
 *
 * ## Why an override is not a declaration
 *
 * An override has something to disagree with. A declared-spend field was built
 * to mgrin's first instinct and rejected on a measurement: asked what they
 * spend monthly, people give typical recurring spend and omit exceptional
 * items — ~6.3k against an actual 8.1k drain on the one production book, a
 * runway overstated ~2x in the flattering direction. Correcting a number you
 * were shown is a different act from volunteering one into a blank field, and
 * only the first can be checked against anything.
 */
export const ObservedBurnAnswerDto = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('override'),
    amount: z.string().refine(
      (val) => isValidDecimalString(val) && new Decimal(val).greaterThan(0),
      // Zero is refused rather than read as "nothing leaves my accounts": it
      // makes the runway infinite, and an infinite runway on the one screen the
      // owner scans is the most flattering possible way to be wrong. Withdrawing
      // an override is `clear`, which is a different and honest statement.
      { message: 'An override must be a positive decimal number string' }
    ),
    currencyTokenId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('confirm'),
    /** The figure the surface actually displayed, echoed back. */
    value: z
      .string()
      .refine((val) => isValidDecimalString(val) && new Decimal(val).greaterThan(0), {
        message: 'A confirmed figure must be a positive decimal number string',
      }),
    currencyTokenId: z.string().uuid(),
  }),
  z.object({ kind: z.literal('clear') }),
]);

export type ObservedBurnAnswerInput = z.infer<typeof ObservedBurnAnswerDto>;

/**
 * A zone name `Intl` can actually interpret, rejecting the shapes that look
 * like one and are not.
 *
 * Two checks rather than one (SC-226):
 *
 * 1. **`Intl` must accept it.** It throws a `RangeError` on an unknown zone,
 *    which is the only authoritative test available — the zone database ships
 *    with the runtime and changes when governments change their clocks.
 * 2. **It must be a NAME, not an offset.** Newer ICU accepts `+08:00`, and a
 *    fixed offset is wrong in every zone that observes DST: it is right today
 *    and an hour out in April, which is the worst possible failure for a
 *    17:00 reminder because it never looks broken. The regex bans a leading
 *    sign, so `Asia/Makassar` and `UTC` pass and `+08:00` does not.
 *
 * Stored NULL until the app reports one, and the reminder job SKIPS a null
 * rather than defaulting to UTC — "17:00 UTC" is 01:00 in Singapore, and a
 * reminder at the wrong hour is worse than no reminder at all.
 */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9+_-]+)*$/;

export function isIanaTimezone(value: string): boolean {
  if (!ZONE_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .min(1)
  // Longest real zone name is `America/Argentina/ComodRivadavia` at 32; 64
  // leaves room for the database to grow without letting a client post prose.
  .max(64)
  .refine(isIanaTimezone, { message: 'must be an IANA timezone name, e.g. Asia/Makassar' });

export const ReportTimezoneDto = z.object({ timezone: timezoneSchema });

export type ReportTimezoneInput = z.infer<typeof ReportTimezoneDto>;
