import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '@/i18n/locales/en.json';
import {
  documentDetailPath,
  resolveActiveTabPath,
  resolveActiveV3Path,
  V3_CAPTURE_ROUTES,
  V3_DRAWER_PRIMARY,
  V3_DRAWER_SECONDARY,
  V3_NAV_PATHS,
  V3_PAYMENT_ROUTES,
  V3_ROUTES,
  V3_SIDEBAR_SECTIONS,
  V3_TAB_ITEMS,
  vendorPaymentsPath,
} from '@/v3/lib/routes';
import { LEGACY_V2_BASE, LEGACY_V3_BASE, V3_BASE } from '@/v3/lib/ui-version';

/** Every navigable destination. The tab bar's capture slot is deliberately
 *  absent: it has no path, because it opens a sheet rather than going
 *  anywhere. */
const ALL_ITEMS = [
  ...V3_TAB_ITEMS.flatMap((item) => (item.path ? [{ ...item, path: item.path }] : [])),
  ...V3_DRAWER_PRIMARY,
  ...V3_DRAWER_SECONDARY,
  ...V3_SIDEBAR_SECTIONS.flatMap((section) => section.items),
];

function translation(key: string): string | undefined {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in acc)
      return (acc as Record<string, unknown>)[part];
    return undefined;
  }, en) as string | undefined;
}

describe('the tab bar', () => {
  test('has five slots — four destinations plus More', () => {
    // Below three a tab bar is not worth its chrome; above five the labels
    // truncate. More is a drawer trigger, not a route, so it is not in the
    // list — which is why this asserts four.
    expect(V3_TAB_ITEMS).toHaveLength(4);
  });

  test('spends exactly one slot on the distinguished capture action', () => {
    const actions = V3_TAB_ITEMS.filter((item) => item.emphasis === 'action');
    expect(actions).toHaveLength(1);
  });

  test('the capture slot goes nowhere, because it is an action', () => {
    // V3-14: capture opens a sheet over the screen you are already reading, so
    // choosing how to add data never costs you your place. A path here would
    // make it a destination again, and the tab bar would render it as a link.
    const [capture] = V3_TAB_ITEMS.filter((item) => item.emphasis === 'action');
    expect(capture?.path).toBeUndefined();
  });

  test('reads Home · Accounts · Add · Money, in that order', () => {
    // V3-40: Accounts holds the second slot, not Holdings. An account list is
    // what you scan; a holdings list is what you drill into once you have
    // picked one. Order is the assertion because the slots are read left to
    // right and the capture action has to stay in the middle.
    expect(V3_TAB_ITEMS.map((item) => item.path)).toEqual([
      V3_ROUTES.home,
      V3_ROUTES.accounts,
      undefined,
      V3_ROUTES.money,
    ]);
  });

  test('spends no slot on Holdings, which the drawer carries instead', () => {
    const paths = V3_TAB_ITEMS.map((item) => item.path);

    expect(paths).not.toContain(V3_ROUTES.holdings);
    expect(V3_DRAWER_PRIMARY.map((item) => item.path)).toContain(V3_ROUTES.holdings);
  });
});

describe('the More drawer', () => {
  test('shows six destinations in its grid, which is what fits at the 40% rest height', () => {
    expect(V3_DRAWER_PRIMARY).toHaveLength(6);
  });

  test('puts Review first, so the badged item never needs scrolling into view', () => {
    // This is the assertion that replaces the `scrollIntoView` hack at
    // AppShell.tsx:71-79. If Review ever falls out of the grid, the hack
    // becomes necessary again and this test is the warning.
    expect(V3_DRAWER_PRIMARY[0]?.path).toBe(V3_ROUTES.review);
  });

  test('the grid and the overflow list never offer the same destination twice', () => {
    const primary = new Set(V3_DRAWER_PRIMARY.map((item) => item.path));
    for (const item of V3_DRAWER_SECONDARY) expect(primary.has(item.path)).toBe(false);
  });
});

describe('the route table', () => {
  // v3 owns the root since V3-19, and both prefixes the app has ever answered
  // on are retired: `/v3` from the rebuild, `/v2` from the interface SC-423
  // deleted. A destination under either is a link into a redirect at best.
  test('every destination lives outside the retired prefixes', () => {
    for (const item of ALL_ITEMS) {
      expect(item.path.startsWith('/')).toBe(true);
      for (const retired of [LEGACY_V2_BASE, LEGACY_V3_BASE]) {
        expect(item.path === retired || item.path.startsWith(`${retired}/`)).toBe(false);
      }
    }
  });

  test('every label key resolves in the locale bundle', () => {
    for (const item of ALL_ITEMS) expect(translation(item.labelKey)).toBeString();
    for (const section of V3_SIDEBAR_SECTIONS) expect(translation(section.titleKey)).toBeString();
  });

  test('V3_NAV_PATHS is the deduplicated union of every surface', () => {
    expect(new Set(V3_NAV_PATHS).size).toBe(V3_NAV_PATHS.length);
    for (const item of ALL_ITEMS) expect(V3_NAV_PATHS).toContain(item.path);
  });
});

describe('resolveActiveV3Path', () => {
  test('exact matches win', () => {
    expect(resolveActiveV3Path(V3_ROUTES.holdings)).toBe(V3_ROUTES.holdings);
  });

  test('a detail page inherits the list it lives under', () => {
    expect(resolveActiveV3Path(`${V3_ROUTES.holdings}/abc123`)).toBe(V3_ROUTES.holdings);
  });

  test('the most specific entry wins, not the first that matches', () => {
    expect(resolveActiveV3Path(V3_ROUTES.recurring)).toBe(V3_ROUTES.recurring);
    expect(resolveActiveV3Path(`${V3_ROUTES.recurring}/xyz`)).toBe(V3_ROUTES.recurring);
  });

  test('the v3 root covers only itself', () => {
    expect(resolveActiveV3Path(V3_BASE)).toBe(V3_BASE);
    expect(resolveActiveV3Path(`${V3_BASE}/nowhere`)).toBeNull();
  });

  test('a sibling with a shared prefix does not match', () => {
    expect(resolveActiveV3Path(`${V3_ROUTES.money}-archive`)).toBeNull();
  });

  test('a trailing slash is not a different route', () => {
    expect(resolveActiveV3Path(`${V3_ROUTES.holdings}/`)).toBe(V3_ROUTES.holdings);
  });
});

describe('resolveActiveTabPath', () => {
  test('a tab stays lit across its whole section', () => {
    expect(resolveActiveTabPath(V3_ROUTES.money)).toBe(V3_ROUTES.money);
    expect(resolveActiveTabPath(V3_ROUTES.recurring)).toBe(V3_ROUTES.money);
    expect(resolveActiveTabPath(`${V3_ROUTES.recurring}/xyz`)).toBe(V3_ROUTES.money);
  });

  test('Home lights only on Home', () => {
    expect(resolveActiveTabPath(V3_BASE)).toBe(V3_BASE);
    expect(resolveActiveTabPath(V3_ROUTES.money)).not.toBe(V3_BASE);
  });

  test('Accounts stays lit on an account it is peeking at', () => {
    expect(resolveActiveTabPath(V3_ROUTES.accounts)).toBe(V3_ROUTES.accounts);
    expect(resolveActiveTabPath(`${V3_ROUTES.accounts}/acc1`)).toBe(V3_ROUTES.accounts);
  });

  test('a drawer destination lights no tab at all', () => {
    // Lighting the nearest tab on the Vaults screen would be a lie; an
    // unlit bar is the honest answer.
    expect(resolveActiveTabPath(V3_ROUTES.vaults)).toBeNull();
    expect(resolveActiveTabPath(V3_ROUTES.settings)).toBeNull();
    expect(resolveActiveTabPath(V3_ROUTES.holdings)).toBeNull();
  });

  test('holdings narrowed to one account lights Accounts', () => {
    // V3-40's premise interaction: Accounts → a row's peek → View holdings.
    // The reader is one tap deep inside the tab they pressed, so the bar has
    // to say so — and the account filter in the URL is the only thing that
    // distinguishes that arrival from Holdings opened out of the More drawer.
    expect(resolveActiveTabPath(V3_ROUTES.holdings, '?account=acc1')).toBe(V3_ROUTES.accounts);
    expect(resolveActiveTabPath(`${V3_ROUTES.holdings}/h1`, '?account=acc1')).toBe(
      V3_ROUTES.accounts
    );
  });

  test('holdings narrowed by anything else still lights nothing', () => {
    // The institution peek's own "View holdings" arrives here, and
    // Institutions is a drawer destination — so an unlit bar is right.
    expect(resolveActiveTabPath(V3_ROUTES.holdings, '?institution=inst1')).toBeNull();
    expect(resolveActiveTabPath(V3_ROUTES.holdings, '?account=')).toBeNull();
    expect(resolveActiveTabPath(V3_ROUTES.holdings, '')).toBeNull();
  });

  test('an account filter on some other surface is not a drill-down', () => {
    // Only Holdings is reachable from an account. A stray `?account=` on the
    // Vaults screen must not light a tab the reader never pressed.
    expect(resolveActiveTabPath(V3_ROUTES.vaults, '?account=acc1')).toBeNull();
  });

  test('an unknown route lights nothing', () => {
    expect(resolveActiveTabPath(`${V3_BASE}/nowhere`)).toBeNull();
  });
});

describe('the Files routes (V3-43)', () => {
  test('a document keeps the mirrored v2 path, so the switch stays a prefix add', () => {
    expect(documentDetailPath('doc-1')).toBe('/documents/doc-1');
    expect(V3_CAPTURE_ROUTES.invoiceUpload).toBe('/documents/upload');
  });

  test('an id that would mint a second segment is encoded', () => {
    // Ids are opaque. One with a slash in it would otherwise produce a path
    // the detail route cannot match and the peek parser would reject.
    expect(documentDetailPath('a/b')).toBe('/documents/a%2Fb');
  });

  /**
   * The upload screen shares its segment with the document detail route, so
   * `documents/:documentId` would claim the word "upload" as an id. React
   * Router ranks static over dynamic and resolves it correctly either way, but
   * that ranking was never the only thing enforcing it: the version switch
   * read a pattern table whose matcher had no such rule, and a
   * `/documents/upload` reached through it became a document called "upload".
   *
   * That table went with the interface it served (SC-423), so what is left to
   * assert is the registration order itself — which is what the comment beside
   * those two routes in `V3App` says it is documenting.
   */
  test('the upload screen is registered before the id below Files', () => {
    const source = readFileSync(join(import.meta.dir, '../../../src/v3/V3App.tsx'), 'utf8');
    const upload = source.indexOf('V3_CAPTURE_ROUTES.invoiceUpload');
    const detail = source.indexOf('/:documentId');
    expect(upload).toBeGreaterThan(-1);
    expect(detail).toBeGreaterThan(-1);
    expect(upload).toBeLessThan(detail);
  });

  test('Files lights on its own screens, including the upload and a document', () => {
    expect(resolveActiveV3Path(V3_ROUTES.files)).toBe(V3_ROUTES.files);
    expect(resolveActiveV3Path(documentDetailPath('doc-1'))).toBe(V3_ROUTES.files);
    expect(resolveActiveV3Path(V3_CAPTURE_ROUTES.invoiceUpload)).toBe(V3_ROUTES.files);
  });

  test('approving an extraction opens the payment form inside v3', () => {
    expect(V3_PAYMENT_ROUTES.fromExtraction('ex 1')).toBe(
      '/payments/recurring/new?fromExtraction=ex%201'
    );
  });

  // SC-83. The parameter name is the contract, not an implementation detail:
  // `V3DataView` seeds a filter from `?<filterKey>=`, so this URL only narrows
  // the list because the recurring list declares a filter keyed `vendor`.
  test("a vendor's peek links into the recurring list narrowed to it", () => {
    expect(vendorPaymentsPath('v 1')).toBe('/payments/recurring?vendor=v%201');
  });

  test('the narrowed recurring list is still the Money tab, and still Recurring', () => {
    // The link crosses from Vendors to Recurring, so the bar has to follow it
    // — an unlit Money tab there would say the reader had left the section.
    expect(resolveActiveTabPath('/payments/recurring', '?vendor=v1')).toBe(V3_ROUTES.money);
    expect(resolveActiveV3Path('/payments/recurring')).toBe(V3_ROUTES.recurring);
  });
});
