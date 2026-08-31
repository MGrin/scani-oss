/**
 * One policy, two sources, and they must not be able to disagree quietly.
 *
 * `public/_headers` is read by static hosts that understand that format
 * (Cloudflare Pages, Netlify). The self-hosted image serves through nginx,
 * which does not read it at all — before SC-561 that meant every
 * self-hosted deployment shipped ZERO of the eight declared headers while
 * the file sat in the web root looking authoritative.
 * `nginx-security-headers.inc.template` is the nginx half. These tests fail
 * the build when the two drift.
 *
 * The last block is the one a future reader will be tempted to delete,
 * because it asserts something about nginx rather than about this app:
 * `add_header` inheritance is REPLACE, not merge. A `location` that
 * declares any header of its own silently drops every inherited one, and
 * `nginx -t` is perfectly happy with the result. That is exactly how
 * `X-Robots-Tag` came to be sent on `/version.json` and on no HTML
 * response at all. Keep it.
 */

import { describe, expect, test } from 'bun:test';

const HEADERS_FILE = await Bun.file(new URL('../../public/_headers', import.meta.url)).text();
const NGINX_INCLUDE = await Bun.file(
  new URL('../../nginx-security-headers.inc.template', import.meta.url)
).text();
const NGINX_SITE = await Bun.file(new URL('../../nginx.conf.template', import.meta.url)).text();
const DOCKERFILE = await Bun.file(new URL('../../Dockerfile', import.meta.url)).text();

/**
 * `connect-src` is the one directive the two sources are ALLOWED to
 * differ on, and only in one direction: nginx parameterises it so an
 * operator can widen it for a split-origin deployment, while `_headers`
 * carries the concrete origins of whatever static host reads it.
 */
const CONNECT_SRC = 'connect-src';
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text nginx's envsubst looks for, not an unfinished template literal — asserting on it is the point
const CSP_PLACEHOLDER = '${CSP_CONNECT_SRC}';

/**
 * Headers nginx sends that `_headers` deliberately does not declare.
 *
 * Empty, and worth keeping empty rather than deleting: the set is what
 * makes adding an nginx-only header a decision somebody records, instead
 * of a diff nobody reads.
 *
 * It held `X-Robots-Tag` until SC-841, on the grounds that "the Pages
 * deployment of the same bundle is governed by its own host config".
 * `public/_headers` IS that config, and it did not declare the header —
 * so the exception was not describing a deliberate split, it was holding
 * open the one gap it looked like it had considered. Measured against
 * production 2026-08-31, unauthenticated: `app.scani.xyz` returned zero
 * `X-Robots-Tag` on any response, served no `robots.txt`, and answered
 * `/robots.txt` with the SPA shell. Both hosts now declare it, so it is
 * an agreement the tests above check rather than an exception.
 */
const NGINX_ONLY_HEADERS = new Set<string>([]);

/** The `/*` block of a `_headers` file: `  Name: value` lines under `/*`. */
function parseHeadersFile(source: string): Map<string, string> {
  const out = new Map<string, string>();
  let inGlobal = false;
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inGlobal = line.trim() === '/*';
      continue;
    }
    if (!inGlobal) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

/** `add_header Name "value" always;` → Map(Name → value). */
function parseAddHeaders(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/^\s*add_header\s+(\S+)\s+"([^"]*)"\s*(always\s*)?;/gm)) {
    out.set(m[1] ?? '', m[2] ?? '');
  }
  return out;
}

/** `a 'x'; b y; c` → Map(a → "'x'", b → 'y', c → ''). */
function parseCsp(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of value.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(' ');
    if (at === -1) out.set(trimmed, '');
    else out.set(trimmed.slice(0, at), trimmed.slice(at + 1).trim());
  }
  return out;
}

interface NginxLocation {
  label: string;
  body: string;
}

/**
 * Drop `#` comments before any structural parse. Not cosmetic: the prose in
 * this config says the word "location", and without this the block matcher
 * happily treated a sentence as a location whose body ran to the next brace.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '"') quoted = !quoted;
        else if (line[i] === '#' && !quoted) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Every `location … { … }` in a site config, innermost bodies included. */
function parseLocations(rawSource: string): NginxLocation[] {
  const source = stripComments(rawSource);
  const found: NginxLocation[] = [];
  const opener = /location\s+([^{]+?)\s*\{/g;
  for (const m of source.matchAll(opener)) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    found.push({ label: (m[1] ?? '').trim(), body: source.slice(bodyStart, i - 1) });
  }
  return found;
}

/** A location's own directives, with any nested `location` blocks removed. */
function ownDirectives(body: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) out += ch;
  }
  // Drop the `location <label>` fragment left behind by each removed block.
  return out.replace(/location\s+[^\n]*$/gm, '');
}

const declared = parseHeadersFile(HEADERS_FILE);
const nginx = parseAddHeaders(NGINX_INCLUDE);

describe('_headers and the nginx include declare one policy', () => {
  test('every header `_headers` declares, nginx sends with the same value', () => {
    for (const [name, value] of declared) {
      if (name === 'Content-Security-Policy') continue;
      expect(`${name}: ${nginx.get(name)}`).toBe(`${name}: ${value}`);
    }
  });

  test('nginx sends nothing extra beyond the declared exceptions', () => {
    const extra = [...nginx.keys()].filter(
      (name) => !declared.has(name) && !NGINX_ONLY_HEADERS.has(name)
    );
    expect(extra).toEqual([]);
  });

  test('the two CSPs agree on every directive but connect-src', () => {
    const fromFile = parseCsp(declared.get('Content-Security-Policy') ?? '');
    const fromNginx = parseCsp(nginx.get('Content-Security-Policy') ?? '');

    expect([...fromNginx.keys()].sort()).toEqual([...fromFile.keys()].sort());
    for (const [directive, value] of fromFile) {
      if (directive === CONNECT_SRC) continue;
      expect(`${directive} ${fromNginx.get(directive)}`).toBe(`${directive} ${value}`);
    }
  });

  test('nginx parameterises connect-src and `_headers` still starts at self', () => {
    const fromNginx = parseCsp(nginx.get('Content-Security-Policy') ?? '');
    const fromFile = parseCsp(declared.get('Content-Security-Policy') ?? '');
    expect(fromNginx.get(CONNECT_SRC)).toBe(CSP_PLACEHOLDER);
    expect(fromFile.get(CONNECT_SRC)?.startsWith("'self'")).toBe(true);
  });

  test('the CSP still constrains the directives an XSS payload would use', () => {
    const fromNginx = parseCsp(nginx.get('Content-Security-Policy') ?? '');
    expect(fromNginx.get('default-src')).toBe("'self'");
    expect(fromNginx.get('script-src')).toBe("'self'");
    expect(fromNginx.get('object-src')).toBe("'none'");
    expect(fromNginx.get('frame-ancestors')).toBe("'none'");
    expect(fromNginx.get('base-uri')).toBe("'self'");
  });
});

describe('the placeholder cannot reach a response uninterpolated', () => {
  test('the Dockerfile defines CSP_CONNECT_SRC, since envsubst skips unset vars', () => {
    expect(/^ENV CSP_CONNECT_SRC=/m.test(DOCKERFILE)).toBe(true);
  });

  test('the include is copied where the image runs envsubst over it', () => {
    expect(DOCKERFILE).toContain(
      'COPY apps/frontend/app/nginx-security-headers.inc.template /etc/nginx/templates/security-headers.inc.template'
    );
  });

  test('the image stops serving the `_headers` file nginx does not read', () => {
    expect(DOCKERFILE).toContain('rm -f /usr/share/nginx/html/_headers');
  });
});

describe('nginx add_header inheritance is replace, not merge', () => {
  const INCLUDE = 'include /etc/nginx/conf.d/security-headers.inc;';

  /**
   * The proxied locations set `X-Robots-Tag` by hand instead of pulling the
   * include, because the api emits its own CSP / X-Frame-Options /
   * X-Content-Type-Options (`apps/backend/api/src/index.ts`) and a browser
   * INTERSECTS two Content-Security-Policy headers rather than replacing
   * one with the other. Adding the include there would silently tighten
   * whatever policy the api chose.
   */
  const PROXY_EXEMPT = new Set(['/api/', '/ws']);

  test('every location that sets a header of its own also pulls the include', () => {
    const offenders = parseLocations(NGINX_SITE)
      .filter(({ label, body }) => {
        if (PROXY_EXEMPT.has(label)) return false;
        const own = ownDirectives(body);
        return /^\s*add_header\s/m.test(own) && !own.includes(INCLUDE);
      })
      .map(({ label }) => label);

    expect(offenders).toEqual([]);
  });

  test('the exempt proxy locations keep the one header the api does not set', () => {
    for (const { label, body } of parseLocations(NGINX_SITE)) {
      if (!PROXY_EXEMPT.has(label)) continue;
      expect(`${label}: ${parseAddHeaders(ownDirectives(body)).get('X-Robots-Tag')}`).toBe(
        `${label}: noindex, nofollow`
      );
    }
  });

  test('the site config reaches the include for the SPA shell and its assets', () => {
    const covered = parseLocations(NGINX_SITE)
      .filter(({ body }) => ownDirectives(body).includes(INCLUDE))
      .map(({ label }) => label);

    expect(covered).toContain('/');
    expect(covered).toContain('= /index.html');
    expect(covered).toContain('= /healthz');
    expect(covered.some((label) => label.startsWith('~*'))).toBe(true);
  });
});
