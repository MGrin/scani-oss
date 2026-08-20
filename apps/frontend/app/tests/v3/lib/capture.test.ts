import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPTURE_GROUPS, CAPTURE_ROUTES, captureContextQuery, captureHref } from '@/v3/lib/capture';
import { V3_CAPTURE_ROUTES, V3_PAYMENT_ROUTES } from '@/v3/lib/routes';

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
   * of the seven rows pointed at classic-UI screens through
   * `V2_BORROWED_PATHS`; the flag, the borrow list and the gate that needed
   * them went with the tree they served (SC-423).
   *
   * The property they stood in for was always "this row leads somewhere that
   * exists", and it was checked by round-tripping the path through the
   * two-generation crossing — a proxy, because that crossing fell back to Home
   * for a path v3 had not built. With one interface it can be asked directly:
   * every row's path is a value of `V3_CAPTURE_ROUTES`, and every one of those
   * is registered by `V3App`. A row pointing anywhere else now reaches the
   * not-found screen, which is legible but is still not where the capture
   * sheet should send anybody.
   */
  const V3_APP = readFileSync(join(import.meta.dir, '../../../src/v3/V3App.tsx'), 'utf8');

  test('every row leads to a capture route', () => {
    const known = new Set<string>([...Object.values(V3_CAPTURE_ROUTES), V3_PAYMENT_ROUTES.create]);
    for (const route of CAPTURE_ROUTES) {
      expect({ id: route.id, known: known.has(route.path.split('?')[0] as string) }).toEqual({
        id: route.id,
        known: true,
      });
    }
  });

  test('and every capture route is one V3App registers', () => {
    for (const key of Object.keys(V3_CAPTURE_ROUTES)) {
      expect({ key, registered: V3_APP.includes(`V3_CAPTURE_ROUTES.${key}`) }).toEqual({
        key,
        registered: true,
      });
    }
    // The scan is only worth having if it can fail.
    expect(V3_APP.includes('V3_CAPTURE_ROUTES.notARoute')).toBe(false);
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
