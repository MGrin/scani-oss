import { describe, expect, test } from 'bun:test';
import { V3_CAPTURE_ROUTES, V3_PAYMENT_ROUTES, V3_ROUTES } from '../../src/v3/lib/routes';

// nginx's `location ^~ /assets/` and the Pages `_worker.js` answer a missing
// hashed file with a 404 (SC-1318), so an app route under `/assets/` loads
// only by client-side navigation: a refresh or a shared link is a 404.
// `/assets/new` shipped that way (SC-1698).
const paths = [V3_ROUTES, V3_PAYMENT_ROUTES, V3_CAPTURE_ROUTES].flatMap((routes) =>
  Object.values(routes).filter((value): value is string => typeof value === 'string')
);

describe('no app route lives under the hashed-asset prefix', () => {
  test('the reader finds the routes — a control, so an empty read cannot pass', () => {
    expect(paths).toContain(V3_CAPTURE_ROUTES.valuedAsset);
    expect(paths.length).toBeGreaterThan(20);
  });

  test('no route is /assets or below it', () => {
    expect(paths.filter((path) => path === '/assets' || path.startsWith('/assets/'))).toEqual([]);
  });
});
