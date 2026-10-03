import { describe, expect, test } from 'bun:test';
import { realtimeSocketUrl, resolveApiBaseUrl } from '../../src/lib/api-base-url';

/**
 * SC-1542. Realtime never connected on the published image. The app opens its
 * WebSocket at the api base itself, which is `/api/` behind the image's nginx,
 * and the only block matching that path cleared `Connection`: the handshake
 * came back a plain 200 and the app retried once a second for ever. The block
 * that did carry the upgrade headers sat at `/ws`, a path the api answers 404
 * on. Measured on a clean v0.52.0 install: api direct `/` 101, nginx `/api/`
 * 200, `/ws` 404 both ways.
 *
 * So the path the client asks for and the path nginx upgrades are derived from
 * one place here, and compared.
 */

const NGINX_SITE = await Bun.file(new URL('../../nginx.conf.template', import.meta.url)).text();

function exactLocationBlock(path: string): string {
  const start = NGINX_SITE.indexOf(`location = ${path} {`);
  if (start === -1) return '';
  return NGINX_SITE.slice(start, NGINX_SITE.indexOf('\n    }', start));
}

const IMAGE_SOCKET = realtimeSocketUrl(resolveApiBaseUrl('/api', 'http://localhost:8580'));

describe('where the app opens its realtime socket', () => {
  test('the published image asks its own origin, at the api base', () => {
    expect(IMAGE_SOCKET).toBe('ws://localhost:8580/api/');
  });

  test('a build that knows its api asks that origin, over TLS when the api is', () => {
    expect(
      realtimeSocketUrl(resolveApiBaseUrl('https://api.example.com', 'https://app.example.com'))
    ).toBe('wss://api.example.com/');
  });
});

describe('nginx upgrades the path the app asks for', () => {
  const block = exactLocationBlock(new URL(IMAGE_SOCKET).pathname);

  test('there is a block for exactly that path, reaching the api root', () => {
    expect(block).toMatch(/proxy_pass\s+\$\{API_UPSTREAM\}\/;/);
  });

  test('it passes the upgrade through', () => {
    expect(block).toMatch(/proxy_set_header\s+Upgrade\s+\$http_upgrade;/);
    expect(block).toMatch(/proxy_set_header\s+Connection\s+\$connection_upgrade;/);
  });

  test('a request that is not an upgrade keeps an empty Connection, as before', () => {
    expect(NGINX_SITE).toMatch(
      /map \$http_upgrade \$connection_upgrade \{\s+default\s+upgrade;\s+''\s+'';\s+\}/
    );
  });

  test('a socket is not cut at the 90s the tRPC block allows', () => {
    expect(block).toMatch(/proxy_read_timeout\s+3600s;/);
  });

  test('control: the prefix block still clears Connection, which is why the exact one exists', () => {
    const start = NGINX_SITE.indexOf('location /api/ {');
    const prefix = NGINX_SITE.slice(start, NGINX_SITE.indexOf('\n    }', start));
    expect(prefix).toMatch(/proxy_set_header\s+Connection\s+"";/);
    expect(prefix).not.toMatch(/Upgrade/);
  });

  test('no block upgrades a path the api does not serve', () => {
    expect(NGINX_SITE).not.toMatch(/location \/ws\b/);
  });
});
