import { describe, expect, test } from 'bun:test';
import { CAPTURE_GROUPS, CAPTURE_ROUTES, captureContextQuery, captureHref } from '@/v3/lib/capture';
import { V3_CAPTURE_ROUTES } from '@/v3/lib/routes';
import { counterpartPath, uiVersionForPath } from '@/v3/lib/ui-version';

describe('the capture catalogue', () => {
  test('groups by what the person has, not by which subsystem takes it', () => {
    // The assertion that encodes the whole redesign. v2 splits the same seven
    // routes into "Portfolio" and "Payments", which is the shape of the
    // codebase; the invoice reader and the screenshot reader are the same
    // subsystem and belong in different groups here, while manual holdings and
    // a recurring bill are different subsystems in one.
    expect(CAPTURE_GROUPS.map((group) => group.key)).toEqual(['upload', 'connect', 'manual']);
    const byId = new Map(CAPTURE_ROUTES.map((route) => [route.id, route.group]));
    expect(byId.get('screenshot')).toBe('upload');
    expect(byId.get('invoice')).toBe('upload');
    expect(byId.get('manual')).toBe('manual');
    expect(byId.get('payment')).toBe('manual');
  });

  test('every group has routes and every route has a group', () => {
    for (const group of CAPTURE_GROUPS) expect(group.routes.length).toBeGreaterThan(0);
    const grouped = CAPTURE_GROUPS.flatMap((group) => group.routes);
    expect(grouped).toHaveLength(CAPTURE_ROUTES.length);
  });

  test('ids are unique, so a row cannot silently shadow another', () => {
    const ids = CAPTURE_ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a screenshot and a statement file are two possessions at one importer', () => {
    // Not an accident to be deduplicated later: the person holds one or the
    // other and should not have to work out that both are "file import".
    const paths = CAPTURE_ROUTES.filter((route) => route.group === 'upload').map((r) => r.path);
    expect(paths.filter((path) => path === V3_CAPTURE_ROUTES.fileImport)).toHaveLength(2);
  });
});

describe('the debt V3-14 took on', () => {
  /**
   * What V3-44 paid off, asserted as the property rather than as a list. Four
   * of the seven rows pointed at v2 screens through `V2_BORROWED_PATHS`; the
   * flag, the borrow list and the gate that needed them are all gone, and the
   * only way that can regress is a new row added with a classic-UI path.
   */
  test('every row addresses v3, not the classic UI', () => {
    for (const route of CAPTURE_ROUTES) {
      expect({ id: route.id, version: uiVersionForPath(route.path) }).toEqual({
        id: route.id,
        version: 'v3',
      });
    }
  });

  /**
   * Stronger than the above, and the assertion that actually replaces the
   * borrow check: since v3 took the root (V3-19), *any* path without the `/v2`
   * prefix reads as v3 — including one v3 never built, which resolves to the
   * catch-all and is handed straight back to the classic UI. Round-tripping
   * through `counterpartPath` is what proves the screen exists, because the
   * crossing to v3 falls back to Home for a path v3 has not built.
   */
  test('and every one of them is a v3 screen that exists', () => {
    for (const route of CAPTURE_ROUTES) {
      const path = route.path.split('?')[0] as string;
      expect({ id: route.id, path: counterpartPath(counterpartPath(path, 'v2'), 'v3') }).toEqual({
        id: route.id,
        path,
      });
    }
  });
});

describe('context forwarding', () => {
  test('carries the account and institution, and nothing else', () => {
    const query = captureContextQuery(
      new URLSearchParams({ accountId: 'acc-1', institutionId: 'inst-1', fromExtraction: 'x' })
    );
    const forwarded = new URLSearchParams(query.slice(1));
    expect(forwarded.get('accountId')).toBe('acc-1');
    expect(forwarded.get('institutionId')).toBe('inst-1');
    expect(forwarded.get('fromExtraction')).toBeNull();
  });

  test('is empty when there is no context', () => {
    expect(captureContextQuery(new URLSearchParams())).toBe('');
  });

  test('only reaches the routes that read it', () => {
    const wallet = CAPTURE_ROUTES.find((route) => route.id === 'wallet');
    const manual = CAPTURE_ROUTES.find((route) => route.id === 'manual');
    expect(wallet && captureHref(wallet, '?accountId=acc-1')).toBe(V3_CAPTURE_ROUTES.walletImport);
    expect(manual && captureHref(manual, '?accountId=acc-1')).toContain('?accountId=acc-1');
  });

  test('adds no query string when there is no context to add', () => {
    const manual = CAPTURE_ROUTES.find((route) => route.id === 'manual');
    expect(manual && captureHref(manual, '')).not.toContain('?');
  });
});
