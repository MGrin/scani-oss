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

function isIanaTimezone(value: string): boolean {
  if (!ZONE_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .min(1)
  // Longest real zone name is `America/Argentina/ComodRivadavia` at 32; 64
  // leaves room for the database to grow without letting a client post prose.
  .max(64)
  .refine(isIanaTimezone, { message: 'must be an IANA timezone name, e.g. Asia/Makassar' });

export const ReportTimezoneDto = z.object({ timezone: timezoneSchema });

/**
 * What the `users` handlers that answer with a user — `getCurrent` and
 * `updateCurrent` — may put in a browser payload.
 * Declared, rather than inherited from whatever the row happens to hold.
 *
 * Each returned the whole `users` row until SC-688, so every
 * signed-in tab received `email_unsubscribe_token`: the bearer credential
 * every unsubscribe link authenticates on, deliberately kept off `users.id`
 * precisely because ids travel through responses and logs. Nothing on the
 * frontend read it. It travelled because the handlers returned a ROW instead
 * of a SHAPE, which is also why it arrived silently — no caller asked for it
 * and no reviewer had to approve it.
 *
 * The token is today's instance; the absent projection is what would have
 * produced the next one. So this list is the fix rather than a select is: a
 * column added to `users` is invisible to the browser until somebody edits
 * these five lines, and editing them is a diff a reviewer sees. Wired through
 * `.output()`, so the server refuses to serve a field it does not name — a
 * client cannot opt out of it and a stale deploy cannot leak past it.
 *
 * Every field here has a live reader in `apps/frontend/app`: `name`,
 * `baseCurrencyId` and `email` in `ProfileSettings`, `timezone` in
 * `TimezoneReporter`. The six `observedBurn*` columns left with the Planning
 * page (SC-1409); asking `getCurrent` for them is how the token was found in
 * the first place.
 *
 * `costBasisMethod` is deliberately NOT here either, even though
 * `UpdateUserDto` accepts it — no screen reads it back today, and adding it
 * here on the argument that it might is how the list stops meaning anything.
 */
export const CurrentUserDto = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  timezone: z.string().nullable(),
  baseCurrencyId: z.string().uuid().nullable(),
});
