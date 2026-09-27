import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { viteMissingAsset } from '@scani/ui/vite/missing-asset-plugin';

// SC-1318: the worker is tested as SHIPPED — the plugin writes `_worker.js`
// into a scratch dist, and that file is what these cases import and call.

let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

type Handler = (request: Request, env: unknown) => Promise<Response>;

async function shippedWorker(): Promise<Handler> {
  dir = mkdtempSync(join(tmpdir(), 'sc1318-asset-worker-'));
  const plugin = viteMissingAsset();
  // Vite's ObjectHook union is what the cast gets past; the hook reads no `this`.
  (plugin.writeBundle as (o: { dir: string }) => void)({ dir });
  const mod = (await import(join(dir, '_worker.js'))) as { default: { fetch: Handler } };
  return mod.default.fetch;
}

function assets(response: Response) {
  return { ASSETS: { fetch: async () => response } };
}

const SHELL = () =>
  new Response('<!doctype html>', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
const CHUNK = () =>
  new Response('export {}', {
    status: 200,
    headers: { 'content-type': 'application/javascript', etag: '"abc"' },
  });
const request = new Request('https://app.scani.xyz/assets/V3App-ZZZZnope.js');

describe('the /assets/* worker Pages runs (SC-1318)', () => {
  test('the SPA shell standing in for a missing chunk becomes a 404 nobody caches', async () => {
    const response = await (await shippedWorker())(request, assets(SHELL()));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).not.toContain('text/html');
  });

  test('a real chunk passes through, immutable, with its own headers', async () => {
    const response = await (await shippedWorker())(request, assets(CHUNK()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(await response.text()).toBe('export {}');
  });

  test('a revalidation is not a miss', async () => {
    const response = await (await shippedWorker())(
      request,
      assets(new Response(null, { status: 304 }))
    );
    expect(response.status).toBe(304);
  });

  test('a genuine 404 from the asset server stays uncacheable', async () => {
    const response = await (await shippedWorker())(
      request,
      assets(new Response('gone', { status: 404, headers: { 'cache-control': 'max-age=60' } }))
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('the worker runs on /assets/* and nowhere else', () => {
    dir = mkdtempSync(join(tmpdir(), 'sc1318-asset-routes-'));
    (viteMissingAsset().writeBundle as (o: { dir: string }) => void)({ dir });
    expect(JSON.parse(readFileSync(join(dir, '_routes.json'), 'utf8'))).toEqual({
      version: 1,
      include: ['/assets/*'],
      exclude: [],
    });
  });
});
