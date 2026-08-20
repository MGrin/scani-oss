import { z } from 'zod';
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
