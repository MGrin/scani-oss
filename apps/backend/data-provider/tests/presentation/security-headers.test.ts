import { describe, expect, test } from 'bun:test';
import { securityHeaders } from '../../src/presentation/security-headers';

describe('securityHeaders', () => {
  /**
   * SC-121: the console frames `/docs` at its own `/reference` so an installed
   * PWA can get back out of the reference. `DENY` on that one page is what
   * turned the frame into "localhost refused to connect".
   */
  test('the docs page may be framed by its own origin', () => {
    const headers = securityHeaders('/docs', false);
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'self'");
  });

  test('every API surface still refuses framing outright', () => {
    for (const path of ['/trpc/pricing.convertRate', '/openapi.json', '/ready', '/']) {
      const headers = securityHeaders(path, false);
      expect(headers['X-Frame-Options'], path).toBe('DENY');
      expect(headers['Content-Security-Policy'], path).toContain("frame-ancestors 'none'");
    }
  });

  /** A path that merely starts with `/docs` is not the docs page. */
  test('a lookalike path does not inherit the exception', () => {
    expect(securityHeaders('/docsomething', false)['X-Frame-Options']).toBe('DENY');
  });

  test('Scalar’s CDN is whitelisted on the docs page and nowhere else', () => {
    expect(securityHeaders('/docs', false)['Content-Security-Policy']).toContain(
      'https://cdn.jsdelivr.net'
    );
    expect(securityHeaders('/openapi.json', false)['Content-Security-Policy']).not.toContain(
      'jsdelivr'
    );
  });

  test('HSTS ships only where TLS is guaranteed', () => {
    expect(securityHeaders('/', true)['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(securityHeaders('/', false)['Strict-Transport-Security']).toBeUndefined();
  });
});
