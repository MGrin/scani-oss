import { en } from './locales/en';
import { fr } from './locales/fr';
import { ru } from './locales/ru';
import type { EmailStrings } from './strings';

export type { EmailStrings, OtpStringKey } from './strings';
export { fill } from './strings';

/**
 * The languages an auth email can be written in, keyed by base subtag.
 *
 * Keyed by LANGUAGE, not by locale: an email has no dates, no currency and no
 * grouped numbers in it, so `ru-RU` and `ru-KZ` are the same letter. The app's
 * own region setting exists for the formats on screen and has nothing to say
 * here (SC-201).
 */
export const EMAIL_STRINGS: Readonly<Record<string, EmailStrings>> = { en, fr, ru };

/** What a language we cannot write in falls back to — stated, not implied. */
const EMAIL_FALLBACK_LANGUAGE = 'en';

/**
 * The whole letter in one language, or the whole letter in English (SC-412).
 *
 * `undefined` is the ordinary case rather than an error: the sign-in request
 * of a reader on a surface with no language picker carries no language, and
 * the English letter is the right answer to that.
 *
 * `ru-RU`, `RU`, `ru_RU` and `ru` all resolve to `ru` — the value arrives from
 * a browser header written by a client we do not control, so anything that is
 * recognisably a language wins over being strict about the spelling.
 */
export function resolveEmailStrings(language: string | null | undefined): EmailStrings {
  const base = (language ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
  return EMAIL_STRINGS[base] ?? (EMAIL_STRINGS[EMAIL_FALLBACK_LANGUAGE] as EmailStrings);
}
