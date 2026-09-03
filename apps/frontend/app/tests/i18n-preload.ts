/**
 * i18next, initialised, for component tests (SC-201).
 *
 * **Why this exists at all.** react-i18next's `t` and `<Trans>` both fall back
 * to the default instance when no `I18nextProvider` is above them — which is
 * how the app itself works, since nothing wraps the tree in one. In a test
 * with no instance at all, `<Trans>` renders **empty** rather than throwing:
 * `renderToStaticMarkup` produces `<p class="…"></p>` and every assertion
 * about the sentence inside it fails with no indication of the cause. Six
 * tests in `money.test.tsx` failed exactly that way the first time a `<Trans>`
 * landed in `ConvertedTotal`.
 *
 * **Why it does not just import `src/i18n`.** That module discovers locales
 * with `import.meta.glob`, which is a Vite build-time API and is `undefined`
 * under `bun test` — importing it throws before a single test runs. So this
 * mirrors the init rather than sharing it, and mirrors it eagerly with no
 * detector. The locale files are imported directly, so the resource a test
 * renders against is the same file the app ships and the same file
 * `i18n-keys.test.ts` gates.
 *
 * **Russian is registered too, and `lng` stays `en`** (SC-410/SC-411). Every
 * existing test renders in English exactly as before; what the second bundle
 * adds is `getFixedT('ru')`, so a test can assert what a Russian reader is
 * shown rather than only that a key exists. Registering it is the whole cost —
 * without it `getFixedT('ru')` silently falls back to English and a test
 * asserting a translation passes against the untranslated string.
 */

import { addUiLocale } from '@scani/ui/i18n';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { registerDurationFormatter } from '../src/i18n/duration-format';
import shellEn from '../src/i18n/locales/en.json';
import shellRu from '../src/i18n/locales/ru.json';
// v3's half ships in the v3 chunk and is registered by `src/v3/i18n` at run
// time (SC-169). Merging the two here is what keeps this file's promise — that
// a test renders against the same strings the app ships — true across the
// split.
import v3En from '../src/v3/i18n/locales/en.json';
import v3Ru from '../src/v3/i18n/locales/ru.json';

const en = { ...shellEn, ...v3En };
const ru = { ...shellRu, ...v3Ru };

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ru: { translation: ru } },
  lng: 'en',
  fallbackLng: 'en',
  // Same as the app: React escapes for us, and double-escaping turns an
  // apostrophe in "today's rates" into `&#39;` inside an assertion.
  interpolation: { escapeValue: false },
});

// The one part of boot this file IMPORTS rather than mirrors (SC-434). A
// server-produced duration renders through it, so a test without it asserts
// against a raw `{{durationCount, duration}}` and would pin the wrong string.
registerDurationFormatter(i18n);

/**
 * The `ui.` half of the bundle, forwarded into `@scani/ui`'s own instance —
 * mirroring what `src/i18n/index.ts` does at boot (SC-257).
 *
 * Without it a test that renders `V3DataView` gets `ui.dataView.noun.holdings`
 * where the count line should be, because the package resolves `nounKey`
 * against ITS instance and the nouns live in the app's locale file. Two tests
 * failed exactly that way and they were right to: the same omission in a real
 * app is a raw key on every list.
 *
 * It belongs here rather than in each test for the same reason the init does —
 * this file is the one place that mirrors boot, and a per-file registration is
 * a step every future test author has to remember.
 */
addUiLocale('en', { ui: (en as { ui?: Record<string, unknown> }).ui ?? {} });
