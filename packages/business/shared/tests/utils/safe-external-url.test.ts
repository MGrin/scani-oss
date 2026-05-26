import { describe, expect, test } from 'bun:test';
import { safeExternalUrl } from '../../src/utils/safe-external-url';

describe('safeExternalUrl', () => {
  test('accepts https URLs', () => {
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com');
    expect(safeExternalUrl('https://example.com/path?q=1#frag')).toBe(
      'https://example.com/path?q=1#frag'
    );
  });

  test('accepts http URLs', () => {
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com');
  });

  test('rejects javascript: / data: / blob: / vbscript: / file:', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeExternalUrl('JavaScript:alert(1)')).toBeUndefined();
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeExternalUrl('blob:https://example.com/abc')).toBeUndefined();
    expect(safeExternalUrl('vbscript:msgbox(1)')).toBeUndefined();
    expect(safeExternalUrl('file:///etc/passwd')).toBeUndefined();
  });

  test('rejects protocol-relative and same-origin paths', () => {
    expect(safeExternalUrl('//example.com')).toBeUndefined();
    expect(safeExternalUrl('/dashboard')).toBeUndefined();
    expect(safeExternalUrl('dashboard')).toBeUndefined();
  });

  test('rejects whitespace-padded inputs', () => {
    expect(safeExternalUrl(' https://example.com')).toBeUndefined();
    expect(safeExternalUrl('https://example.com ')).toBeUndefined();
    expect(safeExternalUrl('\thttps://example.com')).toBeUndefined();
    expect(safeExternalUrl('https://exa mple.com')).toBeUndefined();
  });

  test('rejects null / undefined / empty / non-string', () => {
    expect(safeExternalUrl(null)).toBeUndefined();
    expect(safeExternalUrl(undefined)).toBeUndefined();
    expect(safeExternalUrl('')).toBeUndefined();
  });

  test('rejects malformed URLs the URL parser cannot parse', () => {
    expect(safeExternalUrl('https://')).toBeUndefined();
    expect(safeExternalUrl('http://')).toBeUndefined();
    expect(safeExternalUrl('not a url')).toBeUndefined();
  });
});
