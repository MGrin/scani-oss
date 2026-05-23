import { describe, expect, test } from 'bun:test';
import { safeRedirectPath } from '../../src/utils/safe-redirect';

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
    expect(safeRedirectPath('https://app.example.com/dashboard', FALLBACK)).toBe(FALLBACK);
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
