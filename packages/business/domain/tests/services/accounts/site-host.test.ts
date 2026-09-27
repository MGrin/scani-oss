import { describe, expect, test } from 'bun:test';
import { siteHost } from '../../../src/services/accounts/site-host';

// SC-1354: a shared institution is keyed by its site. Every spelling of one
// site must reduce to one host, or the catalogue grows a duplicate per spelling.
describe('siteHost', () => {
  test('scheme, www., case, port, path and query all reduce to one host', () => {
    for (const raw of [
      'https://www.revolut.com',
      'http://REVOLUT.com:443/app?x=1',
      'revolut.com/',
      '  www.Revolut.com  ',
      'https://revolut.com.',
    ]) {
      expect(siteHost(raw)).toBe('revolut.com');
    }
  });

  test('keeps subdomains other than www', () => {
    expect(siteHost('https://app.n26.com/login')).toBe('app.n26.com');
  });

  test('refuses what is not a public site name', () => {
    for (const raw of [
      '',
      'localhost',
      'http://localhost:8080',
      '127.0.0.1',
      'http://[::1]/',
      'ftp://bank.com',
      'not a url',
    ]) {
      expect(siteHost(raw)).toBeNull();
    }
  });
});
