import { describe, expect, test } from 'bun:test';

/**
 * SC-1495. When nginx reaches the api through a second Fly proxy hop
 * (flycast), that hop reports nginx's own machine as the client, and every
 * visitor lands on one rate-limit key. nginx therefore repeats the visitor
 * Fly's public proxy named, under a header the second hop leaves alone;
 * `defaultInflowKey` in `@scani/rate-limiter` reads it from a private caller.
 *
 * Both proxied locations carry it, and it is set with `proxy_set_header`, which
 * REPLACES whatever the browser sent under that name.
 */

const NGINX_SITE = await Bun.file(new URL('../../nginx.conf.template', import.meta.url)).text();

function locationBlock(path: string): string {
  const start = NGINX_SITE.indexOf(`location ${path} {`);
  if (start === -1) throw new Error(`location ${path} not found — the test would prove nothing`);
  return NGINX_SITE.slice(start, NGINX_SITE.indexOf('\n    }', start));
}

describe('nginx names the visitor to the api', () => {
  for (const path of ['/api/auth/', '/api/', '/ws']) {
    test(`${path} forwards the Fly-Client-IP it received`, () => {
      expect(locationBlock(path)).toMatch(
        /proxy_set_header\s+X-Scani-Forwarded-Client-IP\s+\$http_fly_client_ip;/
      );
    });
  }
});
