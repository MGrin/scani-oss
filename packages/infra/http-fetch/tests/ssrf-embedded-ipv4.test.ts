import { describe, expect, test } from 'bun:test';
import { assertHostIsPublic, BoundedFetchError, fetchHtmlBounded } from '../src/fetch-html-bounded';

/**
 * SC-1284. The guard unwrapped an IPv4-mapped IPv6 address only in DOTTED
 * form, and WHATWG URL never hands it one: `new URL('http://[::ffff:127.0.0.1]/')`
 * serializes the host as `[::ffff:7f00:1]`, so the mapped branch saw `7f00:1`,
 * `isIP` said no, and the address was judged PUBLIC. Bun's fetch then reached a
 * loopback server through it. NAT64, IPv4-compatible and 6to4 addresses were
 * never unwrapped at all.
 *
 * Every row goes through `new URL(...).hostname`, because that is the string
 * the guard is actually handed — a test that passed `'::ffff:127.0.0.1'`
 * directly would have been green over the bug.
 */

const hostOf = (url: string) => new URL(url).hostname;

const MUST_BLOCK = [
  // The five ALLOWED rows from the ticket.
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:169.254.169.254]/',
  'http://[::ffff:10.0.0.1]/',
  'http://[64:ff9b::7f00:1]/',
  'http://[::127.0.0.1]/',
  // The other embeddings the same unwrap has to cover.
  'http://[2002:7f00:1::]/', // 6to4 of 127.0.0.1
  'http://[2002:a9fe:a9fe::1]/', // 6to4 of 169.254.169.254
  'http://[::ffff:0:a00:1]/', // SIIT, IPv4-translated 10.0.0.1
  'http://[64:ff9b:1::a00:1]/', // RFC 8215 local-use NAT64
  'http://[fe90::1]/', // link-local is fe80::/10, not just fe80:
  'http://[fdaa::3]/', // unique-local — Fly's 6PN
];

describe('embedded IPv4 is classified as the IPv4 it carries', () => {
  for (const url of MUST_BLOCK) {
    test(`blocks ${url} (host ${hostOf(url)})`, async () => {
      await expect(assertHostIsPublic(hostOf(url))).rejects.toBeInstanceOf(BoundedFetchError);
    });
  }

  test('the fetcher refuses the ticket row end to end, before any request', async () => {
    await expect(fetchHtmlBounded('http://[::ffff:127.0.0.1]/')).rejects.toMatchObject({
      reason: 'blocked-host',
    });
  });
});

describe('THE CONTROLS — public addresses stay allowed', () => {
  // Without these, a guard that refused every IPv6 literal would pass the block
  // above. The mapped public row is the one that proves the unwrap classifies
  // rather than blanket-refusing the prefix.
  const MUST_ALLOW: Array<[string, string]> = [
    ['http://93.184.216.34/', '93.184.216.34'],
    ['http://[2606:4700:4700::1111]/', '2606:4700:4700::1111'],
    ['http://[::ffff:8.8.8.8]/', '::ffff:808:808'],
    ['http://[64:ff9b::808:808]/', '64:ff9b::808:808'],
  ];
  for (const [url, pinned] of MUST_ALLOW) {
    test(`allows ${url}`, async () => {
      await expect(assertHostIsPublic(hostOf(url))).resolves.toBe(pinned);
    });
  }
});
