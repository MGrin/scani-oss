import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  applyDocumentUiVersion,
  LEGACY_V2_BASE,
  LEGACY_V3_BASE,
  stripLegacyBase,
  V3_BASE,
} from '../../../src/v3/lib/ui-version';

/**
 * What is left of the two-generation apparatus, and it is a short list
 * (SC-423).
 *
 * This file used to assert the whole crossing: which URL belonged to which
 * tree, where the switch was allowed to land, what a stored preference did to
 * a root URL, and that the token attribute came back off on a classic-UI
 * route. All of it described a second interface, and all of it went with that
 * interface — the assertions are not weakened here, they are gone because
 * their subject is.
 *
 * The two properties that outlive it are the ones about readers rather than
 * about trees: an old URL still arrives, and the token layer is on the
 * document.
 */

describe('stripLegacyBase', () => {
  test('drops the prefix v3 spent the rebuild under', () => {
    expect(stripLegacyBase('/v3/holdings', LEGACY_V3_BASE)).toBe('/holdings');
    expect(stripLegacyBase('/v3', LEGACY_V3_BASE)).toBe('/');
    expect(stripLegacyBase('/v3/payments/recurring/abc', LEGACY_V3_BASE)).toBe(
      '/payments/recurring/abc'
    );
  });

  /**
   * The classic interface's namespace. Its route names were v3's under a
   * prefix by construction, so stripping it lands the reader on the screen
   * they asked for wherever v3 built the counterpart.
   */
  test('drops the prefix the classic interface lived under', () => {
    expect(stripLegacyBase('/v2/holdings', LEGACY_V2_BASE)).toBe('/holdings');
    expect(stripLegacyBase('/v2/payments/recurring/abc', LEGACY_V2_BASE)).toBe(
      '/payments/recurring/abc'
    );
  });

  /**
   * `/v2` itself, which is what the installed PWA's start URL is for a reader
   * who had chosen the classic interface. It has to be the home screen and not
   * the empty string, which is not a URL at all.
   */
  test('a bare prefix lands on the home screen', () => {
    expect(stripLegacyBase('/v2', LEGACY_V2_BASE)).toBe(V3_BASE);
    expect(stripLegacyBase('/v3', LEGACY_V3_BASE)).toBe(V3_BASE);
  });

  /**
   * The query rides along, and dropping it was a real bug the last time this
   * crossing was written (V3-46): both prefixes spelled their filter keys the
   * same way the root does, so `?account=<id>` means the same thing on the
   * other side of the strip. Losing it silently is what made every completion
   * surface in the app land the reader on an unfiltered list.
   */
  test('keeps the query', () => {
    expect(stripLegacyBase('/v3/holdings', LEGACY_V3_BASE, '?account=acc-1')).toBe(
      '/holdings?account=acc-1'
    );
    expect(stripLegacyBase('/v2/holdings', LEGACY_V2_BASE, '?institution=inst-1')).toBe(
      '/holdings?institution=inst-1'
    );
  });

  /**
   * A path v3 never built comes through unchanged rather than being redirected
   * to the home screen. It reaches v3's catch-all, which quotes the address
   * back — the whole point of SC-423 is that this is a real destination now.
   * The old crossing could not do this: with nothing to render it, a fallback
   * to Home was the least bad answer available.
   */
  test('a path v3 never built keeps its address rather than being sent home', () => {
    expect(stripLegacyBase('/v2/add-data', LEGACY_V2_BASE)).toBe('/add-data');
  });
});

/**
 * The token block's scope (V3-19). `[data-ui="v3"]` on `<html>` is `:root` in
 * everything but spelling, which is what puts the token layer on the document
 * — its background behind an overscroll, its scrollbars, and anything Radix
 * portals onto `<body>`.
 */
describe('applyDocumentUiVersion', () => {
  function fakeRoot() {
    const attrs = new Map<string, string>();
    return {
      setAttribute: (name: string, value: string) => {
        attrs.set(name, value);
      },
      removeAttribute: (name: string) => {
        attrs.delete(name);
      },
      get: (name: string) => attrs.get(name) ?? null,
    };
  }

  test('hangs the token block off the document root', () => {
    const root = fakeRoot();
    applyDocumentUiVersion(root as unknown as HTMLElement);
    expect(root.get('data-ui')).toBe('v3');
  });

  /**
   * It used to take the attribute back off for a classic-UI route, which is
   * why a component kept it in step across every navigation. With one
   * interface it is set once from `main.tsx` before React's first paint and
   * never removed — so applying it twice has to be the same as applying it
   * once, and there is no path that clears it.
   */
  test('is idempotent, so one call before first paint is enough', () => {
    const root = fakeRoot();
    applyDocumentUiVersion(root as unknown as HTMLElement);
    applyDocumentUiVersion(root as unknown as HTMLElement);
    expect(root.get('data-ui')).toBe('v3');
  });
});
