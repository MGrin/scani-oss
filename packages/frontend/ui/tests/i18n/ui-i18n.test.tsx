import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getI18n, useTranslation } from 'react-i18next';
import { addUiLocale, setUiLanguage, uiI18n, uiT, useUiTranslation } from '../../src/i18n';
import en from '../../src/i18n/locales/en.json';

/**
 * The property SC-250 exists for: **a component from this package renders real
 * copy in a tree that has never heard of i18next.**
 *
 * Three of the four consumers — `frontend/cloud`, `frontend/admin`,
 * `frontend/landing` — have no i18next dependency at all, and `cloud` imports
 * `V3DataView`, which imports the toast. A bare `useTranslation()` there does
 * not throw; it logs `NO_I18NEXT_INSTANCE` and returns `t = (key) => key`, so
 * the screen reads `ui.toast.errorTitle`. `<Trans>` renders empty. Both are
 * silent, and both are worse than the untranslated English they replace.
 *
 * These tests are the reason that cannot come back. Note what they do NOT do:
 * install a provider. If any of them ever needs one to pass, the package has
 * regressed to depending on its host.
 */

const UI_SRC = join(import.meta.dir, '../../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function resolve(key: string, bundle: unknown = en): unknown {
  let node: unknown = bundle;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe('@scani/ui owns an initialised i18next instance', () => {
  test('it is ready without anybody initialising it', () => {
    expect(uiI18n.isInitialized).toBe(true);
    expect(uiI18n.language).toBe('en');
  });

  test('uiT resolves rather than echoing the key back', () => {
    const title = uiT('ui.toast.errorTitle');
    expect(title).toBe('Something went wrong');
    expect(title).not.toBe('ui.toast.errorTitle');
  });

  test('a component using the instance renders copy with NO provider above it', () => {
    function Probe() {
      const { t, ready } = useUiTranslation();
      return createElement('p', null, `${String(ready)}|${t('ui.toast.viewDetails')}`);
    }
    // Deliberately not wrapped in <I18nextProvider> — that is the whole claim.
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<p>true|View Details</p>');
  });

  test('importing this module does NOT capture the global default instance', () => {
    // The first attempt at this file called `.use(initReactI18next)` on the
    // package instance. That module's `init` runs react-i18next's `setI18n`,
    // so the package became what every bare `useTranslation()` in the APP
    // resolved against — 28 tests across ten v3 surfaces started rendering
    // `v3.home.disclosure.show` instead of "Show". The blast radius is the
    // whole SPA and nothing throws, so this is pinned rather than remembered.
    //
    // The preload has initialised the app's bundle on the default instance;
    // asking it for an app key must still get the app's answer, and asking it
    // for a package key must MISS.
    function BareProbe() {
      const { t } = useTranslation();
      return createElement('p', null, t('v3.home.disclosure.show'));
    }
    expect(renderToStaticMarkup(createElement(BareProbe))).toBe('<p>Show {{label}}</p>');
    expect(uiI18n).not.toBe(getI18n());
  });

  test('the detail frame interpolates both halves', () => {
    expect(uiT('ui.toast.detail', { context: 'Creating payment', message: 'boom' })).toBe(
      'Creating payment: boom'
    );
  });

  test('$meta describes the locale and never reaches a key', () => {
    // It is picker metadata, not copy; leaving it in the bundle would make
    // `t('$meta.name')` resolve to a language name.
    expect(en.$meta.name).toBe('English');
    expect(uiT('$meta.name')).toBe('$meta.name');
  });
});

describe('the host app can move the package', () => {
  test('a language added and selected wins, and switching back restores English', async () => {
    addUiLocale('fr', { ui: { toast: { errorTitle: 'Ça a raté' } } });
    await setUiLanguage('fr');
    // Reads through `uiT`, which is the module-level export every call site in
    // the package uses. i18next REPLACES `instance.t` on `changeLanguage`, so a
    // reference bound at import time would still say "Something went wrong"
    // here — English correct forever, every translation stale.
    expect(uiT('ui.toast.errorTitle')).toBe('Ça a raté');

    // A key the injected locale does not carry falls back to the package's own
    // English rather than rendering the key — the same partial-translation
    // fallback the app relies on.
    expect(uiT('ui.toast.viewDetails')).toBe('View Details');

    await setUiLanguage('en');
    expect(uiT('ui.toast.errorTitle')).toBe('Something went wrong');
  });
});

describe('every key the package asks for exists', () => {
  // Both shapes: `uiT('k')` at module level, and `t('k')` from
  // `useUiTranslation` inside a component. Plus the `…Key: 'k'` indirection
  // that a table entry uses, which grep for `t('k')` would never find.
  const KEY_CALL = /(?:\buiT\(|\bt\()\s*'(ui\.[^']+)'/g;
  const KEY_FIELD = /\b\w*[kK]ey:\s*'(ui\.[^']+)'/g;

  test('every key call site resolves in en.json', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(UI_SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const re of [KEY_CALL, KEY_FIELD]) {
        for (const match of src.matchAll(re)) {
          seen++;
          // A PLURALISED key lives in en.json as `key_one` / `key_other` and the
          // bare key is correctly absent (SC-368). The package gained its first
          // two — `ui.dataView.itemCount` and `ui.dataView.table.rowCount`, the
          // `sr-only` nouns beside a group's count — and without this the guard
          // reported both as missing, whose only fix would have been to write
          // English pluralisation back into the component.
          const key = match[1]!;
          if (typeof resolve(key) !== 'string' && typeof resolve(`${key}_other`) !== 'string') {
            missing.push(`${file.replace(/.*\/src\//, 'src/')} → ${key}`);
          }
        }
      }
    }
    // Without this the suite goes green the day the regex stops matching —
    // exactly how SC-175's locale test passed while asserting nothing.
    expect(seen).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });

  test('no component in this package calls a BARE useTranslation()', () => {
    // The rule SC-250 established, made enforceable now that components in here
    // actually use a hook. A bare `useTranslation()` resolves against
    // react-i18next's global default — the host app's instance in
    // `frontend/app`, and NOTHING in `cloud`, `admin` and `landing`, where it
    // returns `t = (key) => key` and paints the key on the screen. The package
    // must always go through `useUiTranslation`, which pins the instance.
    const offenders: string[] = [];
    for (const file of sourceFiles(UI_SRC)) {
      if (file.endsWith('/i18n/index.ts')) continue; // where the hook is defined
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/(?<!useUi)\buseTranslation\s*\(/.test(line)) {
            offenders.push(`${file.replace(/.*\/src\//, 'src/')}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  test('no call site carries English alongside its key', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(UI_SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (
            /\b(?:uiT|t)\(\s*'ui\.[^']+'\s*,\s*['"`]/.test(line) ||
            /\bdefaultValue\s*:/.test(line)
          ) {
            offenders.push(`${file.replace(/.*\/src\//, 'src/')}:${i + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * SC-202. `<Trans>` inside this package MUST be given `i18n={uiI18n}`.
 *
 * The kit's instance deliberately never calls `initReactI18next` (SC-250) —
 * doing so would hijack react-i18next's global default for the whole app. The
 * consequence is that a bare `<Trans>` here resolves against that global, not
 * against the kit's own catalogue: in `apps/frontend/app` it appears to work,
 * because the app initialises one; in `cloud`, which has no i18next at all, it
 * renders EMPTY rather than throwing.
 *
 * Found by rendering the real component. Nothing else catches it — the key
 * resolves, the scanner reports the file done, and `bun run type-check` sees a
 * valid `components` map.
 */
describe('Trans inside the kit is bound to the kit instance', () => {
  test('every <Trans> in src passes i18n={uiI18n}', () => {
    const unbound: string[] = [];
    for (const file of sourceFiles(UI_SRC)) {
      // Comments blanked first: `src/i18n/index.ts` explains `<Trans>` in a
      // docblock, and a doc comment that quotes the shape it argues about is
      // indistinguishable from a call site to a regex (SC-301).
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const match of src.matchAll(/<Trans\b([\s\S]*?)>/g)) {
        if (!/i18n=\{uiI18n\}/.test(match[1] ?? '')) {
          unbound.push(file.replace(/.*\/src\//, 'src/'));
        }
      }
    }

    expect(unbound).toEqual([]);
  });

  test('the install steps render their words, not nothing', () => {
    for (const key of ['ui.install.iosStep2', 'ui.install.iosStep3', 'ui.install.androidStep2']) {
      expect(uiI18n.t(key)).not.toBe('');
      expect(uiI18n.t(key)).not.toBe(key);
    }
  });
});
