import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../src/fetch-html-bounded';
import {
  extractIconHrefs,
  fetchImageBounded,
  fetchSiteIcon,
  sniffImageType,
} from '../src/site-icon';

/**
 * SC-208. The server half of "stop asking google.com for every institution
 * mark".
 *
 * Every case here injects its own `fetch`, so nothing touches a network — and
 * public hops use IP LITERALS rather than hostnames, for the reason
 * `fetch-redirect-ssrf.test.ts` gives: `assertHostIsPublic` resolves a hostname
 * before judging it, so a case written with `example.com` fails in a sandbox
 * with no resolver, for a reason unrelated to what it is testing.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const ICO_BYTES = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

function imageResponse(bytes: Uint8Array, contentType = 'image/png'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

/** A fetch that answers by URL, and records what it was asked for. */
function serving(routes: Record<string, () => Response>): {
  fetch: FetchLike;
  visited: string[];
} {
  const visited: string[] = [];
  return {
    visited,
    fetch: async (url: string) => {
      visited.push(url);
      const handler = routes[url];
      if (!handler) return new Response(null, { status: 404 });
      return handler();
    },
  };
}

describe('sniffImageType — the served type comes from the bytes', () => {
  test.each([
    ['png', PNG_BYTES, 'image/png'],
    ['gif', GIF_BYTES, 'image/gif'],
    ['ico', ICO_BYTES, 'image/x-icon'],
    ['jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
  ])('%s is identified', (_label, bytes, expected) => {
    expect(sniffImageType(bytes as Uint8Array)).toBe(expected);
  });

  test('webp needs the RIFF header AND the WEBP tag, not just RIFF', () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageType(wav)).toBeNull();
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  test('SVG is refused, even though it is a perfectly good icon format', () => {
    // Not an oversight. SVG is the one image format that can carry script, and
    // these bytes are re-served from api.scani.xyz — an <img> would not run it,
    // a direct navigation would. A site with only an SVG icon gets the letter
    // tile, which is the documented fallback.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(sniffImageType(svg)).toBeNull();
  });

  test('an HTML error page is not an image, whatever the server called it', () => {
    const html = new TextEncoder().encode('<!doctype html><html><body>404</body></html>');
    expect(sniffImageType(html)).toBeNull();
  });

  test('an empty body is not an image', () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe('extractIconHrefs — which declared icon to try first', () => {
  test('the largest declared size wins', () => {
    const html = `<head>
      <link rel="icon" href="/small.png" sizes="16x16">
      <link rel="icon" href="/big.png" sizes="192x192">
      <link rel="icon" href="/mid.png" sizes="32x32">
    </head>`;
    expect(extractIconHrefs(html)).toEqual(['/big.png', '/mid.png', '/small.png']);
  });

  test('the legacy `shortcut icon` spelling is found without being named', () => {
    expect(extractIconHrefs('<head><link rel="shortcut icon" href="/f.ico"></head>')).toEqual([
      '/f.ico',
    ]);
  });

  test('an apple-touch-icon outranks an unsized plain icon', () => {
    const html = `<head>
      <link rel="icon" href="/plain.png">
      <link rel="apple-touch-icon" href="/apple.png">
    </head>`;
    expect(extractIconHrefs(html)[0]).toBe('/apple.png');
  });

  test('mask-icon is skipped — it renders as a black silhouette', () => {
    // Picking it produces an icon that looks BROKEN rather than absent, which
    // is the worse of the two failures.
    const html = '<head><link rel="mask-icon" href="/mask.svg" color="#000"></head>';
    expect(extractIconHrefs(html)).toEqual([]);
  });

  test('only <head> is scanned', () => {
    const html =
      '<head><link rel="icon" href="/real.png"></head><body>' +
      '<link rel="icon" href="/from-body.png"></body>';
    expect(extractIconHrefs(html)).toEqual(['/real.png']);
  });

  test('single quotes, unquoted attributes and entity-escaped hrefs all parse', () => {
    const html = `<head>
      <link rel='icon' href='/a.png'>
      <link rel=icon href=/b.png>
      <link rel="icon" href="/c.png?v=1&amp;x=2">
    </head>`;
    expect(extractIconHrefs(html)).toEqual(['/a.png', '/b.png', '/c.png?v=1&x=2']);
  });

  test('a page that declares nothing yields nothing rather than throwing', () => {
    expect(extractIconHrefs('<head><title>hi</title></head>')).toEqual([]);
  });
});

describe('fetchImageBounded — the guards', () => {
  test('rejects a non-http protocol before any fetch', async () => {
    await expect(fetchImageBounded('file:///etc/passwd')).rejects.toMatchObject({
      reason: 'invalid-url',
    });
  });

  test('rejects loopback', async () => {
    await expect(fetchImageBounded('http://127.0.0.1/favicon.ico')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('rejects the cloud metadata address', async () => {
    await expect(fetchImageBounded('http://169.254.169.254/favicon.ico')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });

  test('a redirect into the private network is refused mid-walk', async () => {
    // The hop walk is `followRedirectsSafely`'s, shared with the HTML fetcher.
    // This asserts the image path actually goes through it rather than growing
    // its own `redirect: 'follow'`.
    const { fetch } = serving({
      'http://93.184.216.34/favicon.ico': () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/i.png' } }),
    });
    await expect(
      fetchImageBounded('http://93.184.216.34/favicon.ico', {}, fetch)
    ).rejects.toMatchObject({ reason: 'blocked-host' });
  });

  test('a 200 of HTML is refused — this is the common case, not an exotic one', async () => {
    // An SPA answers /favicon.ico with its shell: HTTP 200, text/html, and a
    // body that is not an image. A status-only check would store that.
    const { fetch } = serving({
      'http://93.184.216.34/favicon.ico': () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    await expect(
      fetchImageBounded('http://93.184.216.34/favicon.ico', {}, fetch)
    ).rejects.toMatchObject({ reason: 'bad-content-type' });
  });

  test('a declared Content-Length over the cap is refused before the body is read', async () => {
    const { fetch } = serving({
      'http://93.184.216.34/favicon.ico': () =>
        new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024) },
        }),
    });
    await expect(
      fetchImageBounded('http://93.184.216.34/favicon.ico', {}, fetch)
    ).rejects.toMatchObject({ reason: 'too-large' });
  });

  test('a body that runs past the cap is an error, never a truncation', async () => {
    // Half an image is not an image. Storing one would put a permanently
    // broken icon in the bucket.
    const huge = new Uint8Array(200 * 1024);
    huge.set(PNG_BYTES, 0);
    const { fetch } = serving({
      'http://93.184.216.34/favicon.ico': () => imageResponse(huge),
    });
    await expect(
      fetchImageBounded('http://93.184.216.34/favicon.ico', {}, fetch)
    ).rejects.toMatchObject({ reason: 'too-large' });
  });

  test('a good image comes back with the type read off its bytes, not its header', async () => {
    const { fetch } = serving({
      'http://93.184.216.34/favicon.ico': () =>
        // Servers routinely mislabel .ico files. The header says octet-stream
        // and the bytes say GIF; the bytes win, and a header-only check would
        // have thrown away a perfectly good icon.
        imageResponse(GIF_BYTES, 'application/octet-stream'),
    });
    const icon = await fetchImageBounded('http://93.184.216.34/favicon.ico', {}, fetch);
    expect(icon.contentType).toBe('image/gif');
    expect(icon.bytes).toEqual(GIF_BYTES);
  });

  test('a non-2xx is refused', async () => {
    const { fetch } = serving({});
    await expect(
      fetchImageBounded('http://93.184.216.34/favicon.ico', {}, fetch)
    ).rejects.toMatchObject({ reason: 'bad-status' });
  });
});

describe('fetchSiteIcon — resolve, then fetch', () => {
  const html = (body: string) => async () => ({ html: body, finalUrl: 'http://93.184.216.34/' });

  test('prefers the declared icon over /favicon.ico', async () => {
    const { fetch, visited } = serving({
      'http://93.184.216.34/brand.png': () => imageResponse(PNG_BYTES),
    });
    const icon = await fetchSiteIcon('http://93.184.216.34/', {
      fetchImpl: fetch,
      fetchHtml: html('<head><link rel="icon" href="/brand.png" sizes="64x64"></head>'),
    });
    expect(icon.contentType).toBe('image/png');
    expect(visited).toEqual(['http://93.184.216.34/brand.png']);
  });

  test('a relative href resolves against the page it was declared on', async () => {
    const { fetch } = serving({
      'http://93.184.216.34/assets/icon.png': () => imageResponse(PNG_BYTES),
    });
    const icon = await fetchSiteIcon('http://93.184.216.34/', {
      fetchImpl: fetch,
      fetchHtml: html('<head><link rel="icon" href="assets/icon.png"></head>'),
    });
    expect(icon.sourceUrl).toContain('/assets/icon.png');
  });

  test('falls back to /favicon.ico when nothing is declared', async () => {
    const { fetch, visited } = serving({
      'http://93.184.216.34/favicon.ico': () => imageResponse(ICO_BYTES, 'image/x-icon'),
    });
    const icon = await fetchSiteIcon('http://93.184.216.34/', {
      fetchImpl: fetch,
      fetchHtml: html('<head><title>no icons here</title></head>'),
    });
    expect(icon.contentType).toBe('image/x-icon');
    expect(visited).toEqual(['http://93.184.216.34/favicon.ico']);
  });

  test('a site that refuses us its HTML still gets /favicon.ico tried', async () => {
    // A 403 to a bot user-agent is common, and those sites very often still
    // serve the icon. Ending the resolve on the HTML failure would throw away
    // a large share of the catalog.
    const { fetch, visited } = serving({
      'http://93.184.216.34/favicon.ico': () => imageResponse(PNG_BYTES),
    });
    const icon = await fetchSiteIcon('http://93.184.216.34/', {
      fetchImpl: fetch,
      fetchHtml: async () => {
        throw new Error('HTTP 403');
      },
    });
    expect(icon.contentType).toBe('image/png');
    expect(visited).toEqual(['http://93.184.216.34/favicon.ico']);
  });

  test('a declared icon that 404s does not stop the fallback being tried', async () => {
    const { fetch, visited } = serving({
      'http://93.184.216.34/favicon.ico': () => imageResponse(PNG_BYTES),
    });
    await fetchSiteIcon('http://93.184.216.34/', {
      fetchImpl: fetch,
      fetchHtml: html('<head><link rel="icon" href="/gone.png"></head>'),
    });
    expect(visited).toEqual(['http://93.184.216.34/gone.png', 'http://93.184.216.34/favicon.ico']);
  });

  test('at most two declared candidates are tried, plus the fallback', async () => {
    const { fetch, visited } = serving({});
    await expect(
      fetchSiteIcon('http://93.184.216.34/', {
        fetchImpl: fetch,
        fetchHtml: html(
          `<head>
            <link rel="icon" href="/a.png" sizes="256x256">
            <link rel="icon" href="/b.png" sizes="128x128">
            <link rel="icon" href="/c.png" sizes="64x64">
            <link rel="icon" href="/d.png" sizes="32x32">
          </head>`
        ),
      })
    ).rejects.toMatchObject({ name: 'BoundedFetchError' });
    expect(visited).toEqual([
      'http://93.184.216.34/a.png',
      'http://93.184.216.34/b.png',
      'http://93.184.216.34/favicon.ico',
    ]);
  });

  test('a site with no usable icon anywhere throws rather than returning nothing', async () => {
    const { fetch } = serving({});
    await expect(
      fetchSiteIcon('http://93.184.216.34/', { fetchImpl: fetch, fetchHtml: html('<head></head>') })
    ).rejects.toMatchObject({ name: 'BoundedFetchError' });
  });

  test('a non-http website is refused without a fetch', async () => {
    await expect(fetchSiteIcon('ftp://example.com/')).rejects.toMatchObject({
      reason: 'invalid-url',
    });
  });
});
