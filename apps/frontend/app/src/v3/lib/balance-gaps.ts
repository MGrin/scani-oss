import type { BalanceGap, BalanceGapAnswer } from '@scani/shared';
import { localDateFromIso } from '../components/form/DateField';

/**
 * The date to send with an answer, or `null` for "do not send one" (SC-501).
 *
 * ## Why this is a function and not two lines in the component
 *
 * It is the one piece of this surface a type cannot check and a rendered
 * snapshot cannot see, and it shipped wrong. The component keeps a date in
 * state whether or not the field is on screen, seeded from the interval's
 * close. On a short interval the field is never shown, so that seed is never
 * touched — and it is a DAY, which becomes an instant at **local midnight**.
 * For a reader in UTC+8 that is sixteen hours before the day it names.
 *
 * Sending it anyway made the server clamp a 13:01–14:01 flow to 13:01:00.001
 * instead of stamping the observation that actually measured the change.
 * Nothing failed: the clamp kept the row inside the interval and every test
 * stayed green. It was caught by answering one prompt in a browser and reading
 * the row back.
 *
 * So the rule is: **send a date only when one was asked for.** With no date
 * the server uses the closing observation, which on a short interval is a
 * better answer than the field could have given.
 */
export function balanceGapOccurredAt(
  answer: BalanceGapAnswer,
  gap: Pick<BalanceGap, 'datePrompted'>,
  isoDate: string
): Date | null {
  // Only `flow` carries a date at all. `correction` is dated by the server at
  // the moment the superseded figure entered the record, and `growth` and
  // `unknown` write no dated row.
  if (answer !== 'flow') return null;
  if (!gap.datePrompted) return null;
  // `localDateFromIso` rather than `new Date(value)`: the second is UTC
  // midnight, which every zone west of Greenwich renders as the previous day.
  return localDateFromIso(isoDate);
}
