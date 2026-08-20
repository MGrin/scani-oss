/**
 * Which locale the app FORMATS in, as data rather than as a constant (SC-201).
 *
 * `APP_LOCALE` and `APP_NUMBER_LOCALE` both carry the same promise in their
 * doc comments — *"when real localisation arrives, this constant is the single
 * place that changes, and the call sites, which all omit the argument, need no
 * edit."* This file is that single place. The two constants keep their values
 * and keep being exported; what changes is that the helpers now read a
 * **resolved** locale which, with English selected and no region chosen, is
 * byte-for-byte the pinned pair.
 *
 * ## The decision the pin was waiting on
 *
 * Three candidates, and only one survives contact with SC-175:
 *
 * - **The device locale.** This is what shipped and was reverted: a reader on
 *   a Russian device saw `14 авг. 2026 г.` under an English heading. Dates
 *   that disagree with every word around them are worse than dates in the
 *   wrong regional order.
 * - **The interface language alone.** Correct for most people and wrong for a
 *   real population: someone who reads the interface in English but lives in
 *   Europe gets `Jul 16, 2026` and `1,234.50`. This is a financial product;
 *   `07/05/2026` is either 5 July or 7 May, which is the whole of SC-175.
 * - **The interface language, with one explicit override.** What this file
 *   implements.
 *
 * So: **the formatting locale follows the interface language, and a reader who
 * wants otherwise sets a region.** Nothing reads `navigator.language` — the
 * device never decides, because the device is what got this wrong before.
 *
 * A reader who wants English text with European dates picks English + Germany
 * and gets `en-DE`: `16. Jul 2026`, `1.234.567,5`. One BCP-47 tag, no second
 * formatting model, and the interface stays in the language they asked for.
 *
 * ## Adding a language
 *
 * A row in `LANGUAGE_FORMATS` and a locale JSON file. Nothing else — that is
 * the property this table exists to create, and
 * `apps/frontend/app/tests/lib/i18n-locales.test.ts` fails the build if a
 * locale file appears without its row.
 *
 * Rows exist for all eight of SC-201's target languages before their strings
 * do. They are inert until a locale file exists — `supportedLngs` is computed
 * from the locale directory, so no reader can select a language that is only a
 * row here. Pre-filling them is what makes the string work a data change.
 *
 * **`ar`'s row says `rtl` and that is a direction, not a layout.** Mirroring
 * v3 is SC-201's own step and is not done; the row is honest about the
 * language and says nothing about whether the interface is ready for it.
 */

export type TextDirection = 'ltr' | 'rtl';

export interface LanguageFormat {
  /** CLDR region used for dates when the reader has chosen none. */
  readonly region: string;
  /**
   * Region used for NUMBERS when the reader has chosen none, where it differs
   * from `region`. Exactly one language sets it — see the `en` row.
   */
  readonly numberRegion?: string;
  readonly dir: TextDirection;
}

/**
 * Language → the region its formats default to.
 *
 * **`en` is the only split row, and it is the two pins preserved rather than a
 * new opinion.** Dates default to `GB` because `16 Jul 2026` names its month
 * and therefore cannot be misread; numbers default to `US` because `en-GB`
 * renders USD as `US$1,234.50` and every screen in the product today shows
 * `$1,234.50`. The two constants disagreed before this file existed and the
 * reasons are recorded at each of them; encoding the disagreement here is what
 * makes "English, no region chosen" render exactly what it renders today.
 *
 * An **explicit** region collapses the split — English + Germany is `en-DE`
 * for both. Someone who has chosen a region has chosen; the dollar symbol is
 * not the ambiguity SC-175 was about.
 */
export const LANGUAGE_FORMATS: Readonly<Record<string, LanguageFormat>> = {
  en: { region: 'GB', numberRegion: 'US', dir: 'ltr' },
  ar: { region: 'EG', dir: 'rtl' },
  es: { region: 'ES', dir: 'ltr' },
  fr: { region: 'FR', dir: 'ltr' },
  id: { region: 'ID', dir: 'ltr' },
  ja: { region: 'JP', dir: 'ltr' },
  pt: { region: 'PT', dir: 'ltr' },
  ru: { region: 'RU', dir: 'ltr' },
  zh: { region: 'CN', dir: 'ltr' },
};

/** The language every unknown tag falls back to, and the app's own. */
export const FALLBACK_LANGUAGE = 'en';

/**
 * The stored value meaning "no region chosen — follow the interface language".
 *
 * A named constant rather than `null` because it is persisted and rendered:
 * the setting is a `<select>` with a real option, and an option whose value is
 * the empty string is the one a browser silently equates with "unset".
 */
export const AUTO_REGION = 'auto';

/**
 * The regions the setting may offer — a candidate list, not the offered one.
 *
 * Every language's default region, plus the ones that answer the case the
 * setting exists for: `DE` for the reader who wants English words and European
 * figures, `BR` because it is a different set of formats from `PT` for the same
 * language. Names are not listed here — `Intl.DisplayNames` renders each code
 * in whatever language the interface is in, so this list needs no translation
 * and gains none when a language is added.
 *
 * **Run it through `supportedFormatRegions` before showing it to anyone.**
 */
export const FORMAT_REGIONS: readonly string[] = [
  'GB',
  'US',
  'DE',
  'FR',
  'ES',
  'PT',
  'BR',
  'RU',
  'CN',
  'JP',
  'EG',
  'ID',
];

/**
 * Does this runtime have formats for this language in this region?
 *
 * **Measured, because the answer is not the same in two runtimes we ship
 * against.** With English selected, Bun's ICU keeps 11 of the 12 candidate
 * regions; Chromium keeps 8 — it has no `en-BR`, `en-RU`, `en-CN` or `en-EG`
 * and silently resolves each to bare `en`, which is `Jul 16, 2026` and
 * `1,234.50`. A reader who picks Brazil and gets American dates has been given
 * a setting that does nothing and told nothing, which is worse than a shorter
 * list.
 *
 * So the picker asks the runtime it is actually running in rather than trusting
 * a list written in another one. `resolvedOptions().locale` is the answer to
 * "what did you do with what I asked for" — if the region subtag did not
 * survive, the region was dropped. Dates and numbers are asked separately
 * because they are separate CLDR datasets and nothing guarantees they agree.
 */
export function isFormatRegionSupported(
  language: string | null | undefined,
  region: string
): boolean {
  const tag = `${baseLanguage(language)}-${region.toUpperCase()}`;
  try {
    const kept = (resolved: string): boolean =>
      new Intl.Locale(resolved).region?.toUpperCase() === region.toUpperCase();
    return (
      kept(new Intl.DateTimeFormat(tag).resolvedOptions().locale) &&
      kept(new Intl.NumberFormat(tag).resolvedOptions().locale)
    );
  } catch {
    return false;
  }
}

/** `FORMAT_REGIONS`, minus the ones this runtime would ignore. */
export function supportedFormatRegions(language: string | null | undefined): string[] {
  return FORMAT_REGIONS.filter((region) => isFormatRegionSupported(language, region));
}

export interface FormatLocale {
  /** Base language subtag — what the TEXT is in. `<html lang>` gets this. */
  readonly language: string;
  /** The reader's explicit region, or `AUTO_REGION`. */
  readonly region: string;
  /** BCP-47 tag for dates. */
  readonly dateLocale: string;
  /** BCP-47 tag for numbers and currency. */
  readonly numberLocale: string;
  readonly dir: TextDirection;
}

/** `en-GB`, `EN_gb`, `en` → `en`. Anything unrecognised → `en`. */
function baseLanguage(language: string | null | undefined): string {
  const base = (language ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
  return base in LANGUAGE_FORMATS ? base : FALLBACK_LANGUAGE;
}

function normalizeRegion(region: string | null | undefined): string {
  const value = (region ?? '').trim().toUpperCase();
  if (!value || value === AUTO_REGION.toUpperCase()) return AUTO_REGION;
  return FORMAT_REGIONS.includes(value) ? value : AUTO_REGION;
}

/**
 * Resolve an interface language and an optional region into the tags the
 * formatters use.
 *
 * Pure, so the table above is testable without a browser, a locale file or a
 * translator — which is the whole point of landing this before any language
 * exists. An unknown language or an unoffered region falls back rather than
 * throwing: both arrive from `localStorage`, where a stale or hand-edited
 * value must degrade to English rather than break every date on the screen.
 */
export function resolveFormatLocale(
  language: string | null | undefined,
  region: string | null | undefined = AUTO_REGION
): FormatLocale {
  const base = baseLanguage(language);
  const chosen = normalizeRegion(region);
  const defaults = LANGUAGE_FORMATS[base] ?? LANGUAGE_FORMATS[FALLBACK_LANGUAGE];
  if (!defaults) throw new Error(`LANGUAGE_FORMATS is missing '${FALLBACK_LANGUAGE}'`);

  const dateRegion = chosen === AUTO_REGION ? defaults.region : chosen;
  const numberRegion = chosen === AUTO_REGION ? (defaults.numberRegion ?? defaults.region) : chosen;

  return {
    language: base,
    region: chosen,
    dateLocale: `${base}-${dateRegion}`,
    numberLocale: `${base}-${numberRegion}`,
    dir: defaults.dir,
  };
}

/**
 * The locale this process formats in.
 *
 * **The server never sets it**, and that is the safety property rather than an
 * omission: `@scani/shared` is imported by `apps/backend/api` and the worker,
 * where a per-request locale in a module global would leak across tenants.
 * Nothing outside a browser calls `setFormatLocale`, so on the server this
 * value stays the English default for the process lifetime — which is exactly
 * the two pins, unchanged. `packages/business/shared/tests/format/locale.test.ts`
 * asserts that untouched default rather than trusting the sentence.
 *
 * A module-level mutable is the shape `@scani/ui`'s `setUiLanguage` already
 * uses for the same reason: the alternative is threading a locale through 44
 * call sites in the app and 3 more in the kit, and every one of them omits the
 * argument today precisely because the constant promised it would never have to.
 */
let current: FormatLocale = resolveFormatLocale(FALLBACK_LANGUAGE, AUTO_REGION);

export function getFormatLocale(): FormatLocale {
  return current;
}

/** Set from the browser only. Returns what it resolved, for the caller to apply. */
export function setFormatLocale(
  language: string | null | undefined,
  region: string | null | undefined = AUTO_REGION
): FormatLocale {
  current = resolveFormatLocale(language, region);
  return current;
}

/** Back to the English default. For tests, and for nothing else. */
export function resetFormatLocale(): void {
  current = resolveFormatLocale(FALLBACK_LANGUAGE, AUTO_REGION);
}

/**
 * The header an auth request carries the reader's interface language in
 * (SC-412).
 *
 * **Not `Accept-Language`.** That header is the DEVICE's language, and the
 * device is what this file already refuses to let decide: a reader on a
 * Russian phone using the app in English got Russian dates, which is the
 * failure SC-175 was reverted over. The reader's *chosen* interface language
 * is the one the letter has to be in, and it is a value only the app knows.
 *
 * Lives in `@scani/shared` because it is the one package the sender and the
 * receiver both import — the auth client in `@scani/ui` sets it, the api reads
 * it — and a header name spelled twice is a header name that drifts once.
 */
export const LANGUAGE_HEADER = 'x-scani-language';
