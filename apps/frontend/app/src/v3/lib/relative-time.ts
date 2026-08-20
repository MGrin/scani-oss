import { type DateInput, formatDate } from '@scani/shared';
import type { TFunction } from 'i18next';

/**
 * "just now" / "5m ago" / "3h ago" / "2d ago", in v3's language.
 *
 * A keyed COPY of `@scani/shared`'s `formatRelative`, not a replacement for it
 * (SC-369). The shared one stays where it is: `@scani/shared` is the wire
 * contract, imported by `apps/backend/api` and the worker, and there is no
 * `t()` on a server — so the fix that worked for `formatPaymentInterval`
 * (take `t` as a first parameter, one module, one copy) is unavailable here.
 * Its 48 call sites across v2, admin and cloud keep the signature they have
 * and die with those trees; only v3's ~10 point at this.
 *
 * Two defects this copy fixes, and the second is the one that is easy to miss:
 *
 * 1. The four strings become keys, so a translator can reach them at all.
 * 2. They start following a locale. Every other renderer in
 *    `shared/format/date.ts` — `formatDate`, `formatDateTime`, `monthName`,
 *    `weekdayName` — goes through `Intl` with `APP_LOCALE` and will follow the
 *    pin the day SC-201 lifts it. `'just now'` and `` `${n}m ago` `` are plain
 *    English concatenation and never would have, which made that file's
 *    docstring — several paragraphs arguing that `en-GB` is a deliberate,
 *    single-point-of-change choice — a promise it could not keep for the four
 *    strings on the most-rendered rows in the app: every job row, every
 *    account row, every review row, every session row.
 *
 * **What "follows the locale" means here is two different things, on purpose.**
 *
 * - The words follow `i18n.language`, the interface language, which is what a
 *   reader sees around them. `{{count, number}}` rather than a bare
 *   `{{count}}` so the numeral follows it too — in `ar-EG` the minutes render
 *   as Arabic-Indic digits with nothing asked of the translator.
 * - The past-30-days fallback still goes through the shared `formatDate` with
 *   no locale argument, and that is now the RIGHT call rather than a hedge.
 *   The objection recorded here when this file was written — that following
 *   the interface language would mean `'en'` → `en-US` → `Jul 16, 2026`
 *   against the rest of the app's `16 Jul 2026` — was answered by making the
 *   resolution a table instead of a fallback chain: `en` with no region chosen
 *   resolves to `en-GB` (`shared/format/locale.ts`). So the fallback follows
 *   the reader exactly as its neighbours do, in one place, for every date at
 *   once, and no call site here changed to get it.
 */

/** Local rather than imported: `toDate` is private to `shared/format/date.ts`,
 *  and exporting it to share three lines would widen the wire contract's
 *  surface for a frontend's convenience. */
function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The thresholds, the rounding and the em-dash for an unreadable input are the
 * shared version's, unchanged — this is a translation, not a redesign, and the
 * two have to agree while both are on screen (v2 and v3 render the same rows).
 *
 * That includes the signed count: a timestamp in the future has produced
 * `-5m ago` since this logic was written, and it is left alone here rather
 * than quietly corrected, because a fix visible on no screen we can currently
 * open is not one to bundle into a string move. English renders `-5` and
 * `5` through the same plural form, so no key hides it.
 */
export function formatRelative(t: TFunction, input: DateInput): string {
  const date = toDate(input);
  if (!date) return '—';
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (Math.abs(seconds) < 45) return t('v3.common.relative.justNow');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return t('v3.common.relative.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return t('v3.common.relative.hours', { count: hours });
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return t('v3.common.relative.days', { count: days });
  return formatDate(date);
}
