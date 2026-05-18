import { describe, expect, test } from 'bun:test';
import {
  rewriteEmailHtml,
  signTrackingToken,
  type TrackingPayload,
  verifyTrackingToken,
} from '../src/email-tracking';

const SECRET = 'unit-test-secret-key-1234567890';

const payload: TrackingPayload = {
  m: 'msg-1',
  t: 'magic-link',
  a: 'app',
  e: 'user@example.com',
  u: 'https://app.scani.xyz/dashboard',
};

describe('tracking tokens', () => {
  test('sign → verify round-trips the payload', () => {
    const token = signTrackingToken(payload, SECRET);
    expect(verifyTrackingToken(token, SECRET)).toEqual(payload);
  });

  test('verify rejects a token signed with a different secret', () => {
    const token = signTrackingToken(payload, SECRET);
    expect(verifyTrackingToken(token, 'a-completely-different-secret')).toBeNull();
  });

  test('verify rejects a tampered payload', () => {
    const token = signTrackingToken(payload, SECRET);
    const [body, sig] = token.split('.');
    const forged = `${Buffer.from('{"m":"x","t":"x","a":"app","e":"evil@x.com"}').toString(
      'base64url'
    )}.${sig}`;
    expect(verifyTrackingToken(forged, SECRET)).toBeNull();
    // sanity: the untampered token still verifies
    expect(verifyTrackingToken(`${body}.${sig}`, SECRET)).not.toBeNull();
  });

  test('verify rejects malformed input', () => {
    expect(verifyTrackingToken('', SECRET)).toBeNull();
    expect(verifyTrackingToken('no-dot', SECRET)).toBeNull();
    expect(verifyTrackingToken('.sig', SECRET)).toBeNull();
  });
});

describe('rewriteEmailHtml', () => {
  const opts = {
    messageId: 'msg-1',
    recipient: 'user@example.com',
    template: 'magic-link',
    app: 'app' as const,
    baseUrl: 'https://track.scani.xyz/',
    secret: SECRET,
  };

  test('rewrites http links through the click endpoint and appends a pixel', () => {
    const html = '<body><a href="https://app.scani.xyz/go">Sign in</a></body>';
    const out = rewriteEmailHtml({ ...opts, html });
    expect(out).toContain('https://track.scani.xyz/e/c/');
    expect(out).toContain('https://track.scani.xyz/e/o/');
    expect(out).not.toContain('href="https://app.scani.xyz/go"');
    expect(out.indexOf('/e/o/')).toBeLessThan(out.indexOf('</body>'));
  });

  test('the rewritten click token carries the original destination URL', () => {
    const html = '<a href="https://app.scani.xyz/go">x</a>';
    const out = rewriteEmailHtml({ ...opts, html });
    const token = out.match(/\/e\/c\/([^"]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(verifyTrackingToken(token as string, SECRET)?.u).toBe('https://app.scani.xyz/go');
  });

  test('leaves mailto and anchor links untouched', () => {
    const html = '<a href="mailto:hi@scani.xyz">mail</a><a href="#top">top</a>';
    const out = rewriteEmailHtml({ ...opts, html });
    expect(out).toContain('href="mailto:hi@scani.xyz"');
    expect(out).toContain('href="#top"');
  });
});
