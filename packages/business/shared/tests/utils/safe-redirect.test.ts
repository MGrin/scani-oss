import { describe, expect, test } from 'bun:test';
import { safeRedirectPath, safeReturnTarget } from '../../src/utils/safe-redirect';

describe('safeRedirectPath', () => {
  const FALLBACK = '/';

  test('returns the input for safe paths', () => {
    expect(safeRedirectPath('/', FALLBACK)).toBe('/');
    expect(safeRedirectPath('/dashboard', FALLBACK)).toBe('/dashboard');
    expect(safeRedirectPath('/dashboard?tab=summary', FALLBACK)).toBe('/dashboard?tab=summary');
    expect(safeRedirectPath('/dashboard#section-2', FALLBACK)).toBe('/dashboard#section-2');
    expect(safeRedirectPath('/keys/abc-123', FALLBACK)).toBe('/keys/abc-123');
  });

  test('rejects absolute URLs', () => {
    expect(safeRedirectPath('https://attacker.com', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('http://attacker.com/foo', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('https://app.scani.xyz/dashboard', FALLBACK)).toBe(FALLBACK);
  });

  test('rejects protocol-relative URLs', () => {
    expect(safeRedirectPath('//attacker.com', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('//attacker.com/foo', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('/\\attacker.com', FALLBACK)).toBe(FALLBACK);
  });

  test('rejects javascript: / data: / blob: schemes', () => {
    expect(safeRedirectPath('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('data:text/html,<script>', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('blob:https://attacker.com/foo', FALLBACK)).toBe(FALLBACK);
  });

  test('rejects whitespace-padded inputs', () => {
    expect(safeRedirectPath(' /dashboard', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('/dashboard ', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('\t/dashboard', FALLBACK)).toBe(FALLBACK);
  });

  test('rejects relative paths and bare hostnames', () => {
    expect(safeRedirectPath('dashboard', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('attacker.com', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('./dashboard', FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('../admin', FALLBACK)).toBe(FALLBACK);
  });

  test('rejects null / undefined / empty / non-string', () => {
    expect(safeRedirectPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeRedirectPath('', FALLBACK)).toBe(FALLBACK);
  });

  test('uses the supplied fallback', () => {
    expect(safeRedirectPath(null, '/keys')).toBe('/keys');
    expect(safeRedirectPath('https://attacker.com', '/dashboard')).toBe('/dashboard');
  });
});

describe('safeReturnTarget', () => {
  test('accepts an allow-listed absolute origin', () => {
    expect(safeReturnTarget('https://cloud.scani.xyz/keys', '/', ['https://cloud.scani.xyz'])).toBe(
      'https://cloud.scani.xyz/keys'
    );
  });

  test('rejects a look-alike origin', () => {
    expect(
      safeReturnTarget('https://cloud.scani.xyz.evil.com/keys', '/', ['https://cloud.scani.xyz'])
    ).toBe('/');
    expect(
      safeReturnTarget('https://evil.com/?x=https://cloud.scani.xyz', '/', [
        'https://cloud.scani.xyz',
      ])
    ).toBe('/');
  });

  test('rejects javascript: and protocol-relative even when allow-list is non-empty', () => {
    expect(safeReturnTarget('javascript:alert(1)', '/', ['https://cloud.scani.xyz'])).toBe('/');
    expect(safeReturnTarget('//cloud.scani.xyz/keys', '/', ['https://cloud.scani.xyz'])).toBe('/');
  });

  test('keeps same-origin paths', () => {
    expect(safeReturnTarget('/settings', '/', [])).toBe('/settings');
  });

  const CLOUD = ['https://cloud.scani.xyz'];

  test('rejects userinfo that names an allowed host before the real one', () => {
    expect(safeReturnTarget('https://cloud.scani.xyz@evil.com/', '/', CLOUD)).toBe('/');
  });

  test('rejects a port mismatch', () => {
    expect(safeReturnTarget('https://cloud.scani.xyz:8443/', '/', CLOUD)).toBe('/');
  });

  test('rejects http against an https allow-list', () => {
    expect(safeReturnTarget('http://cloud.scani.xyz/', '/', CLOUD)).toBe('/');
  });

  test('rejects an absolute URL when the allow-list is empty', () => {
    expect(safeReturnTarget('https://cloud.scani.xyz/keys', '/', [])).toBe('/');
  });

  test('accepts a local dev origin with its port', () => {
    expect(safeReturnTarget('http://localhost:5176/keys', '/', ['http://localhost:5176'])).toBe(
      'http://localhost:5176/keys'
    );
  });

  test('null and undefined fall back', () => {
    expect(safeReturnTarget(null, '/', CLOUD)).toBe('/');
    expect(safeReturnTarget(undefined, '/', CLOUD)).toBe('/');
  });

  test('leading whitespace falls back', () => {
    expect(safeReturnTarget(' https://cloud.scani.xyz/keys', '/', CLOUD)).toBe('/');
  });
});
