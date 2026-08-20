import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EMAIL_STRINGS } from '../../src/i18n';

/**
 * Every language the app offers, the mail can speak (SC-412).
 *
 * The gap this closes is the one SC-409 is about, one process further out: a
 * locale file added to the SPA makes a language selectable immediately —
 * `supportedLngs` is computed from that directory — and the auth letter would
 * go on arriving in English with nothing failing anywhere. A reader would sign
 * in through a fully translated screen and receive a letter in a language they
 * may not read, which is worse than an untranslated screen because it is the
 * step where they are deciding whether to trust the product at all.
 *
 * Read off disk rather than imported: the app's locale directory is discovered
 * with `import.meta.glob`, which does not exist outside Vite, and this package
 * must not depend on the frontend in either direction.
 *
 * **The fix for a failure here is a bundle, not an exemption.** It is about 35
 * strings in `src/i18n/locales/<code>.ts`, and there is no partial option: a
 * letter is in one language or in English, whole.
 */
const APP_LOCALES = resolve(import.meta.dir, '../../../../../apps/frontend/app/src/i18n/locales');

function appLanguages(): string[] {
  return readdirSync(APP_LOCALES)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, '').split('-')[0] as string)
    .sort();
}

describe('the app and the mail speak the same languages', () => {
  test('the app has locales at all', () => {
    // A directory read that silently returns nothing would make the assertion
    // below pass over any gap whatsoever.
    expect(appLanguages().length).toBeGreaterThan(1);
  });

  test('every language the app offers has an email bundle', () => {
    const missing = appLanguages().filter((code) => !(code in EMAIL_STRINGS));
    expect(missing).toEqual([]);
  });
});
