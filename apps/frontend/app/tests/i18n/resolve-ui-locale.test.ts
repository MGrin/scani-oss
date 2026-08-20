/**
 * SC-260. SC-257 fixed a bug that put `ui.dataView.noun.holdings` on screen in
 * every list, and nothing tested the fix — structurally nothing could, because
 * the module holding it uses `import.meta.glob` and throws under `bun test`.
 * The only guard was the comment above the loop, and this repo has already
 * written down what that is worth: *"Documentation of an invariant is not
 * enforcement of it."*
 *
 * The first test below is the bug, exactly: a browser reporting `en-GB` when
 * only `en` has a bundle. It fails against the pre-SC-257 behaviour of trusting
 * the reported code.
 */
import { describe, expect, test } from 'bun:test';
import { resolveUiLocale } from '../../src/i18n/resolve-ui-locale';

/** A lookup over the codes that actually ship a `ui` section. */
function has(...codes: string[]) {
  const bundles = new Map(codes.map((c) => [c, { marker: c }]));
  return (code: string) => bundles.get(code);
}

describe('resolveUiLocale', () => {
  test('a browser on en-GB gets the en bundle — the SC-257 bug', () => {
    // `nonExplicitSupportedLngs` resolves en-GB to en for the app, but
    // `getResourceBundle('en-GB')` is literal and returns undefined. Trusting
    // the reported code forwarded nothing and rendered the raw key.
    const match = resolveUiLocale('en-GB', ['en-GB', 'en'], has('en'));

    expect(match).not.toBeNull();
    expect(match?.code).toBe('en');
  });

  test('an exact match wins over the fallback chain', () => {
    const match = resolveUiLocale('fr', ['fr', 'en'], has('fr', 'en'));

    expect(match?.code).toBe('fr');
  });

  test('a regional bundle wins over its base when both exist', () => {
    // Candidate order puts the reported code first, so adding a real pt-BR
    // bundle starts being used without touching this logic.
    const match = resolveUiLocale('pt-BR', ['pt-BR', 'pt', 'en'], has('pt-BR', 'pt', 'en'));

    expect(match?.code).toBe('pt-BR');
  });

  test('a three-part tag falls back to its bare language', () => {
    // zh-Hans-CN is a real thing a browser reports, and Chinese is one of the
    // eight languages SC-201 ships.
    const match = resolveUiLocale('zh-Hans-CN', [], has('zh'));

    expect(match?.code).toBe('zh');
  });

  test('the resolved chain is used when neither the report nor its base match', () => {
    const match = resolveUiLocale('nb-NO', ['nb-NO', 'no', 'en'], has('no'));

    expect(match?.code).toBe('no');
  });

  test('an empty resolved chain still resolves via the base language', () => {
    // The detector runs inside `init`, so the first call can legitimately
    // happen before `i18n.languages` is populated.
    const match = resolveUiLocale('es-419', [], has('es'));

    expect(match?.code).toBe('es');
  });

  test('no bundle anywhere returns null rather than a code with nothing behind it', () => {
    // Returning `reported` here would hand @scani/ui a code it has nothing
    // for, which puts the raw key back on screen — the same failure, one
    // layer along.
    expect(resolveUiLocale('ja', ['ja', 'en'], has())).toBeNull();
  });

  test('the bundle comes back with the code, so the caller does not look it up twice', () => {
    const match = resolveUiLocale('de-AT', ['de-AT', 'de'], has('de'));

    expect(match?.bundle).toEqual({ marker: 'de' });
  });
});
