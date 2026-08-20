import { AUTO_REGION, type FormatLocale, setFormatLocale } from '@scani/shared';

/**
 * The browser half of the formatting locale (SC-201).
 *
 * `@scani/shared/format/locale` decides *what* a language and a region resolve
 * to; this decides *where the two come from* and *what the document does about
 * it*. Split that way for the same reason `resolve-ui-locale.ts` is split from
 * `i18n/index.ts` (SC-260): that module cannot be imported under `bun test`,
 * because its `import.meta.glob` is undefined there, so anything written
 * inside it is untestable by construction.
 *
 * Everything here takes its `Document` and `Storage` as arguments rather than
 * reaching for the globals, which is what lets the tests drive it.
 */

/**
 * Where the region preference is kept.
 *
 * `localStorage`, beside `scani.language`, and NOT on the account — for now.
 * The language is already device-local (`i18n.changeLanguage` writes it there
 * and no mutation carries it), so putting the region on the server would give
 * one setting two lifetimes: change your language on a phone and it stays on
 * the phone, change your region and it follows you to the laptop. Whichever
 * way that goes it should go for both, and moving both is a schema change and
 * a mutation, which is not this slice.
 */
export const REGION_STORAGE_KEY = 'scani.region';

/**
 * A `Storage` that may not exist.
 *
 * Safari in Lockdown Mode and any embedded webview with storage disabled throw
 * on `localStorage` access rather than returning null. A reader whose browser
 * refuses to remember a region should still see dates.
 */
export type MaybeStorage = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/**
 * `window.localStorage`, or null.
 *
 * The property ACCESS throws in a browser with storage disabled, before any
 * method is called — so the try has to be around the lookup, not only around
 * `getItem`.
 */
export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredRegion(storage: MaybeStorage): string {
  try {
    return storage?.getItem(REGION_STORAGE_KEY) ?? AUTO_REGION;
  } catch {
    return AUTO_REGION;
  }
}

export function writeStoredRegion(storage: MaybeStorage, region: string): void {
  try {
    storage?.setItem(REGION_STORAGE_KEY, region);
  } catch {
    // Nothing to do and nothing worth reporting: the setting applies to this
    // session and is forgotten on reload, which is the documented behaviour of
    // a browser with storage off.
  }
}

export interface DocumentLocaleTarget {
  documentElement: Pick<HTMLElement, 'lang' | 'dir'>;
}

/**
 * Resolve, publish to the formatters, and put it on `<html>`.
 *
 * The two document attributes are not decoration:
 *
 * - **`lang`** is what a screen reader picks a voice from. Without it, VoiceOver
 *   reads French copy with English phonemes, and it is also what `:lang()`,
 *   hyphenation and font fallback key on. There is no `lang` anywhere in this
 *   app today — `index.html` ships whatever Vite's template had — so this is
 *   the first time the document says what language it is in.
 * - **`dir`** is the whole of RTL at the document level, and setting it here is
 *   deliberately NOT a claim that the interface is mirrored. It is not: SC-201
 *   step 3 is the layout pass, and no Arabic locale file exists, so no reader
 *   can reach `dir="rtl"` yet. What this gives is the seam in one place, so
 *   that pass changes CSS rather than hunting for where direction is decided.
 *
 * `lang` gets the base language, not the format tag: it describes the TEXT, and
 * a reader on English copy with German dates is reading English.
 */
export function applyFormatLocale(
  language: string | null | undefined,
  region: string | null | undefined,
  target: DocumentLocaleTarget
): FormatLocale {
  const locale = setFormatLocale(language, region);
  target.documentElement.lang = locale.language;
  target.documentElement.dir = locale.dir;
  return locale;
}
