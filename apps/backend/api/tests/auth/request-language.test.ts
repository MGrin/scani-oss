import { describe, expect, test } from 'bun:test';
import { LANGUAGE_HEADER } from '@scani/shared';
import { languageFromAuthContext } from '../../src/auth/request-language';

function withHeaders(values: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(values) };
}

describe('the language of an auth request', () => {
  test('comes off the header the app sets', () => {
    expect(languageFromAuthContext(withHeaders({ [LANGUAGE_HEADER]: 'ru' }))).toBe('ru');
    expect(languageFromAuthContext(withHeaders({ [LANGUAGE_HEADER]: 'pt-BR' }))).toBe('pt-BR');
  });

  test('is read from the raw request when better-call did not populate headers', () => {
    // `GenericEndpointContext` is `Partial<…>` by type, so which of the two is
    // present is the adapter's business rather than ours.
    const request = new Request('https://api.scani.xyz/api/auth/sign-in/magic-link', {
      headers: { [LANGUAGE_HEADER]: 'ru' },
    });
    expect(languageFromAuthContext({ request })).toBe('ru');
  });

  test('absent is null, and null is not an error', () => {
    // The ordinary case for cloud.scani.xyz, which has no language picker, and
    // for any client that is not our app. The letter is then English, whole.
    expect(languageFromAuthContext(withHeaders({}))).toBeNull();
    expect(languageFromAuthContext(undefined)).toBeNull();
    expect(languageFromAuthContext(withHeaders({ [LANGUAGE_HEADER]: '' }))).toBeNull();
  });

  test('anything that is not shaped like a language tag is dropped', () => {
    // A header is attacker-typed even when what it reaches is harmless.
    // Non-Latin-1 is not in the list because `Headers` refuses to hold it —
    // «русский» throws at construction, one layer below this one.
    for (const junk of ['ru; DROP', '<script>', 'x'.repeat(4096), '../../etc', 'en,ru']) {
      expect(languageFromAuthContext(withHeaders({ [LANGUAGE_HEADER]: junk }))).toBeNull();
    }
  });
});
