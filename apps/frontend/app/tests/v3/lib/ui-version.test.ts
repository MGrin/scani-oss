import { describe, expect, test } from 'bun:test';
import {
  activeUiVersion,
  applyDocumentUiVersion,
  counterpartPath,
  DEFAULT_UI_VERSION,
  gateRedirect,
  legacyV3Redirect,
  readStoredUiVersion,
  storeUiVersion,
  uiVersionForPath,
  V2_BASE,
  V3_BASE,
} from '../../../src/v3/lib/ui-version';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe('uiVersionForPath', () => {
  test('only the /v2 subtree is v2 — the root is v3 now', () => {
    expect(uiVersionForPath(V3_BASE)).toBe('v3');
    expect(uiVersionForPath('/holdings')).toBe('v3');
    expect(uiVersionForPath(V2_BASE)).toBe('v2');
    expect(uiVersionForPath('/v2/holdings')).toBe('v2');
  });

  // `/v2-archive` is not a descendant of `/v2`, the same whole-segment
  // rule `resolveActiveNavPath` uses.
  test('matching is on whole path segments, not raw string prefixes', () => {
    expect(uiVersionForPath('/v2-archive')).toBe('v3');
    expect(uiVersionForPath('/v2something')).toBe('v3');
  });

  test('a trailing slash does not change the answer', () => {
    expect(uiVersionForPath('/v2/')).toBe('v2');
  });
});

/**
 * The flip itself (V3-19), and the promise attached to it: a reader who had
 * already chosen the classic UI must not be moved by the deploy.
 */
describe('activeUiVersion', () => {
  test('no stored preference gets v3 at the root', () => {
    expect(DEFAULT_UI_VERSION).toBe('v3');
    expect(activeUiVersion('/', null)).toBe('v3');
    expect(activeUiVersion('/holdings', null)).toBe('v3');
  });

  /**
   * The reason this is not "redirect everyone to v3": the classic UI's readers
   * have root bookmarks and an installed PWA whose start URL is `/`. Both have
   * to keep landing them in v2.
   */
  test('a stored v2 preference keeps the root in v2', () => {
    expect(activeUiVersion('/', 'v2')).toBe('v2');
    expect(activeUiVersion('/holdings', 'v2')).toBe('v2');
    expect(activeUiVersion('/payments/recurring/abc', 'v2')).toBe('v2');
  });

  test('a stored v3 preference is what the default already is', () => {
    expect(activeUiVersion('/', 'v3')).toBe('v3');
  });

  /**
   * The addressing rule in one assertion: an explicit `/v2` URL is honoured
   * whatever the preference says. It can only come from the switch or a
   * deliberate link, and bouncing it is what would make the classic UI
   * unreachable for anyone who had ever pressed "Back to the new UI".
   */
  test('an explicit /v2 URL wins over any stored preference', () => {
    expect(activeUiVersion('/v2/holdings', 'v3')).toBe('v2');
    expect(activeUiVersion('/v2/holdings', null)).toBe('v2');
    expect(activeUiVersion('/v2', 'v3')).toBe('v2');
  });
});

describe('counterpartPath', () => {
  test('crossing to the side you are already on is a no-op', () => {
    expect(counterpartPath('/v2/holdings', 'v2')).toBe('/v2/holdings');
    expect(counterpartPath('/holdings', 'v3')).toBe('/holdings');
    expect(counterpartPath(V3_BASE, 'v3')).toBe(V3_BASE);
  });

  // The list grows one ticket at a time; this is the assertion that records
  // which surfaces the switch is allowed to land on today.
  test('a v2 path with no v3 counterpart falls back to the v3 home', () => {
    expect(counterpartPath('/v2', 'v3')).toBe(V3_BASE);
    expect(counterpartPath('/v2/holdings/abc/extra', 'v3')).toBe(V3_BASE);
    // Add Data is still a v2-only screen, and the switch has nowhere to put it.
    expect(counterpartPath('/v2/add-data', 'v3')).toBe(V3_BASE);
  });

  // A record's own URL crosses too, so a v2 user reading a holding or a
  // payment and pressing the switch lands on that record, not on Home.
  test('a v2 path whose v3 surface exists crosses to it', () => {
    // Holdings (V3-12). A holding's detail is a page in v2 and a peek sheet
    // in v3, at the same path.
    expect(counterpartPath('/v2/holdings', 'v3')).toBe('/holdings');
    expect(counterpartPath('/v2/holdings/abc', 'v3')).toBe('/holdings/abc');
    // Money (V3-13).
    expect(counterpartPath('/v2/payments', 'v3')).toBe('/payments');
    expect(counterpartPath('/v2/payments/recurring', 'v3')).toBe('/payments/recurring');
    expect(counterpartPath('/v2/payments/recurring/abc', 'v3')).toBe('/payments/recurring/abc');
    expect(counterpartPath('/v2/payments/recurring/abc/edit', 'v3')).toBe(
      '/payments/recurring/abc/edit'
    );
    expect(counterpartPath('/v2/vendors/abc', 'v3')).toBe('/vendors/abc');
    // The More destinations (V3-15). Accounts and institutions cross as peeks,
    // jobs and vaults as pages; groups and tokens have no v2 record page to
    // cross from, so only their index is listed.
    expect(counterpartPath('/v2/review', 'v3')).toBe('/review');
    expect(counterpartPath('/v2/jobs/abc', 'v3')).toBe('/jobs/abc');
    expect(counterpartPath('/v2/accounts/abc', 'v3')).toBe('/accounts/abc');
    expect(counterpartPath('/v2/institutions/abc', 'v3')).toBe('/institutions/abc');
    expect(counterpartPath('/v2/vaults/abc', 'v3')).toBe('/vaults/abc');
    expect(counterpartPath('/v2/groups', 'v3')).toBe('/groups');
    expect(counterpartPath('/v2/tokens', 'v3')).toBe('/tokens');
    // The capture destinations (V3-44). A v2 user mid-import who presses the
    // switch lands on the same form rather than on the v3 home screen.
    expect(counterpartPath('/v2/import', 'v3')).toBe('/import');
    expect(counterpartPath('/v2/wallet-import', 'v3')).toBe('/wallet-import');
    expect(counterpartPath('/v2/integrations', 'v3')).toBe('/integrations');
    expect(counterpartPath('/v2/documents/upload', 'v3')).toBe('/documents/upload');
  });

  test('crossing to v2 adds the prefix, and the v3 home lands on the v2 home', () => {
    expect(counterpartPath('/', 'v2')).toBe('/v2');
    expect(counterpartPath('/holdings/abc', 'v2')).toBe('/v2/holdings/abc');
  });

  /**
   * This is also how every pre-flip bookmark is rescued: `V3App`'s catch-all
   * hands an unrouted root path to exactly this function, so `/add-data` —
   * a screen v3 never built — resolves at `/v2/add-data` rather than 404ing.
   */
  test('a root path v3 does not own still has a v2 address', () => {
    expect(counterpartPath('/add-data', 'v2')).toBe('/v2/add-data');
    expect(counterpartPath('/add-data', 'v2', '?accountId=acc-1')).toBe(
      '/v2/add-data?accountId=acc-1'
    );
  });

  /**
   * The V3-46 defect. `UiVersionGate` rewrote the pathname and threw the query
   * away, so every completion surface in the app landed the user somewhere
   * true-but-useless: an unfiltered holdings list after an import, and — the
   * reported bug — an empty payment form after approving an invoice, because
   * `?fromExtraction=<id>` never survived the crossing.
   */
  test('the query string crosses with the path', () => {
    expect(counterpartPath('/v2/payments/recurring/new', 'v3', '?fromExtraction=abc')).toBe(
      '/payments/recurring/new?fromExtraction=abc'
    );
    expect(counterpartPath('/v2/holdings', 'v3', '?account=acc-1')).toBe('/holdings?account=acc-1');
    expect(counterpartPath('/v2/holdings', 'v3', '?institution=inst-1&group=g-1')).toBe(
      '/holdings?institution=inst-1&group=g-1'
    );
    expect(counterpartPath('/holdings', 'v2', '?account=acc-1')).toBe('/v2/holdings?account=acc-1');
  });

  test('a search with no leading question mark still crosses as a query', () => {
    expect(counterpartPath('/v2/holdings', 'v3', 'account=acc-1')).toBe('/holdings?account=acc-1');
  });

  test('omitting the search is the old behaviour exactly', () => {
    expect(counterpartPath('/v2/holdings', 'v3')).toBe('/holdings');
    expect(counterpartPath('/v2/holdings', 'v3', '')).toBe('/holdings');
  });

  /**
   * A query describes the screen it was written for. Carrying `?account=x` onto
   * the v3 home screen — which is where a path with no counterpart lands —
   * would be a claim about a surface that cannot honour it, and would leave a
   * parameter in the URL that nothing there reads.
   */
  test('the fallback to the v3 home drops the query rather than carrying it', () => {
    expect(counterpartPath('/v2/holdings/abc/extra', 'v3', '?account=acc-1')).toBe(V3_BASE);
    expect(counterpartPath('/v2/not-a-screen', 'v3', '?account=acc-1')).toBe(V3_BASE);
  });

  test('a path already on the target side keeps its query too', () => {
    expect(counterpartPath('/holdings', 'v3', '?account=acc-1')).toBe('/holdings?account=acc-1');
  });

  /**
   * Round-tripping is what the switch does when a reader crosses and comes
   * straight back, and losing the record they were reading is the failure it
   * would show as.
   */
  test('a record survives a round trip in both directions', () => {
    const there = counterpartPath('/payments/recurring/abc', 'v2');
    expect(there).toBe('/v2/payments/recurring/abc');
    expect(counterpartPath(there, 'v3')).toBe('/payments/recurring/abc');
  });
});

/**
 * `UiVersionGate`'s whole decision, which is where the flip's promises are
 * kept. The component is this function plus a `<Navigate>`.
 */
describe('gateRedirect', () => {
  test('a reader with no preference is left on v3 — this is the flip', () => {
    expect(gateRedirect('/', '', null)).toBeNull();
    expect(gateRedirect('/holdings', '', null)).toBeNull();
    expect(gateRedirect('/payments/recurring/abc', '', null)).toBeNull();
  });

  test('a reader who chose v3 is left alone too', () => {
    expect(gateRedirect('/holdings', '', 'v3')).toBeNull();
  });

  /**
   * The promise the amendment attaches to this ticket: the classic UI stays,
   * and someone already on it is not moved by the deploy. Their bookmarks are
   * root URLs and their installed PWA opens `/`, so both have to keep working
   * — on the same screen, not on a home page.
   */
  test('a reader who chose the classic UI is carried to the same screen', () => {
    expect(gateRedirect('/', '', 'v2')).toBe('/v2');
    expect(gateRedirect('/holdings', '', 'v2')).toBe('/v2/holdings');
    expect(gateRedirect('/payments/recurring/abc', '', 'v2')).toBe('/v2/payments/recurring/abc');
  });

  test('and their filter comes with them', () => {
    expect(gateRedirect('/holdings', '?account=acc-1', 'v2')).toBe('/v2/holdings?account=acc-1');
  });

  /**
   * The one thing the gate must never do. A `/v2` URL after the flip can only
   * come from the switch or a deliberate link, so redirecting it would make the
   * classic UI unreachable for exactly the readers who asked for it — and would
   * loop against the switch, which navigates there.
   */
  test('an explicit /v2 URL is never redirected, whatever is stored', () => {
    for (const stored of ['v2', 'v3', null] as const) {
      expect(gateRedirect('/v2/holdings', '', stored)).toBeNull();
      expect(gateRedirect('/v2', '', stored)).toBeNull();
    }
  });
});

describe('legacyV3Redirect', () => {
  test('drops the prefix v3 spent the rebuild under', () => {
    expect(legacyV3Redirect('/v3/holdings')).toBe('/holdings');
    expect(legacyV3Redirect('/v3')).toBe('/');
    expect(legacyV3Redirect('/v3/payments/recurring/abc')).toBe('/payments/recurring/abc');
  });

  test('keeps the query, like every other crossing in this module', () => {
    expect(legacyV3Redirect('/v3/holdings', '?account=acc-1')).toBe('/holdings?account=acc-1');
  });

  /**
   * It lands on the root rather than deciding anything, which is what lets a
   * stored preference still apply: the gate sees the stripped path on the way
   * through and sends a classic-UI reader on to `/v2`.
   */
  test('hands the reader to the gate rather than around it', () => {
    expect(gateRedirect(legacyV3Redirect('/v3/holdings'), '', 'v2')).toBe('/v2/holdings');
  });
});

/**
 * The token block's scope (V3-19). `[data-ui="v3"]` on `<html>` is `:root` in
 * everything but spelling; being able to take it back off is what keeps the
 * classic UI on its own 25 shadcn tokens instead of inheriting v3's.
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

  test('v3 hangs the token block off the document root', () => {
    const root = fakeRoot();
    applyDocumentUiVersion('v3', root as unknown as HTMLElement);
    expect(root.get('data-ui')).toBe('v3');
  });

  test('v2 takes it back off, so the classic UI inherits nothing', () => {
    const root = fakeRoot();
    applyDocumentUiVersion('v3', root as unknown as HTMLElement);
    applyDocumentUiVersion('v2', root as unknown as HTMLElement);
    expect(root.get('data-ui')).toBeNull();
  });

  test('crossing back and forth leaves no residue either way', () => {
    const root = fakeRoot();
    for (const version of ['v3', 'v2', 'v3', 'v2', 'v2'] as const) {
      applyDocumentUiVersion(version, root as unknown as HTMLElement);
    }
    expect(root.get('data-ui')).toBeNull();
  });
});

describe('stored preference', () => {
  test('round-trips through storage', () => {
    const storage = fakeStorage();
    expect(readStoredUiVersion(storage)).toBeNull();
    storeUiVersion('v3', storage);
    expect(readStoredUiVersion(storage)).toBe('v3');
    storeUiVersion('v2', storage);
    expect(readStoredUiVersion(storage)).toBe('v2');
  });

  // A stale or hand-edited value must read as "no preference" rather than
  // routing the user into a version that does not exist.
  test('an unrecognised stored value reads as no preference', () => {
    expect(readStoredUiVersion(fakeStorage({ 'scani.ui-version': 'v4' }))).toBeNull();
  });

  test('a storage that throws is survivable in both directions', () => {
    const hostile = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readStoredUiVersion(hostile)).toBeNull();
    expect(() => storeUiVersion('v3', hostile)).not.toThrow();
  });

  test('no storage at all is survivable', () => {
    expect(readStoredUiVersion(null)).toBeNull();
    expect(() => storeUiVersion('v3', null)).not.toThrow();
  });

  /**
   * A blocked storage reads as no preference, and no preference is v3. That is
   * the right failure: private-mode Safari gets the default interface rather
   * than being stranded.
   */
  test('a reader whose storage is blocked gets the default, not a blank', () => {
    expect(activeUiVersion('/', readStoredUiVersion(null))).toBe(DEFAULT_UI_VERSION);
  });
});
