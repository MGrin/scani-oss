import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { routeComponents, TITLE_CALL } from './route-titles';

/**
 * SC-996 — every registered route names the document.
 *
 * Walking `demo.scani.xyz` found fifteen list routes, five detail routes and
 * every other screen reading the one `<title>` in `index.html`. The fix is a
 * hook each page calls; this is what stops the next route from forgetting it.
 * It is derived from the route tables themselves, so a route added to either
 * one is checked without anybody adding it to a list here.
 *
 * The only hand-written list is what is NOT a page, and it cannot go stale in
 * silence: an entry no table renders any more fails the last test.
 */

const SRC = resolve(import.meta.dir, '../../src');
const TABLES = [join(SRC, 'App.tsx'), join(SRC, 'v3', 'V3App.tsx')];

/** Elements a route renders that are not a screen of their own. */
const NOT_A_PAGE: Record<string, string> = {
  Navigate: 'a redirect — the route it lands on sets the title',
  LegacyV2PathRedirect: 'a redirect — strips `/v2` and lands on a titled route',
  LegacyV3PathRedirect: 'a redirect — strips `/v3` and lands on a titled route',
  ProtectedRoute: 'the pathless auth layout; its children are the pages',
  V3Shell: 'the layout route; its children are the pages',
  V3App: 'a nested route table, checked below as a table of its own',
};

async function allRouteComponents() {
  return (await Promise.all(TABLES.map((table) => routeComponents(table, SRC)))).flat();
}

describe('every route sets the document title', () => {
  test('the reader finds the pages — a control, so an empty read cannot pass', async () => {
    const names = (await allRouteComponents()).map((component) => component.name);
    // Pages the row and its comment named, list and detail both. If the reader
    // broke and returned nothing, every assertion below would pass vacuously.
    for (const page of [
      'HoldingsPage',
      'MoneyPage',
      'SettingsPage',
      'GroupDetailPage',
      'VaultDetailPage',
      'JobDetailPage',
      'NotFoundPage',
      'KitchenSinkPage',
      'AuthScreen',
    ]) {
      expect(names).toContain(page);
    }
  });

  test('each page a route renders calls useDocumentTitle', async () => {
    const missing = (await allRouteComponents())
      .filter((component) => !(component.name in NOT_A_PAGE))
      .filter((component) => !component.body.includes(TITLE_CALL))
      .map((component) => `${component.name} (${component.file})`);
    expect(missing).toEqual([]);
  });

  test('every NOT_A_PAGE entry is still rendered by some route', async () => {
    const names = new Set((await allRouteComponents()).map((component) => component.name));
    expect(Object.keys(NOT_A_PAGE).filter((name) => !names.has(name))).toEqual([]);
  });
});
