import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getPlatform, supportsDeepLinking } from '../../src/lib/pwa-utils';

const originalWindow = (globalThis as { window?: unknown }).window;

function setUserAgent(userAgent: string): void {
  (globalThis as { window?: unknown }).window = {
    navigator: { userAgent },
  };
}

describe('getPlatform', () => {
  beforeEach(() => {
    setUserAgent('');
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  test('returns ios for iPhone user-agent', () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    );
    expect(getPlatform()).toBe('ios');
  });

  test('returns ios for iPad user-agent', () => {
    setUserAgent('Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15');
    expect(getPlatform()).toBe('ios');
  });

  test('returns android for Android user-agent', () => {
    setUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile'
    );
    expect(getPlatform()).toBe('android');
  });

  test('returns desktop for macOS user-agent', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36');
    expect(getPlatform()).toBe('desktop');
  });

  test('returns desktop for Windows user-agent', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    expect(getPlatform()).toBe('desktop');
  });

  test('returns desktop for Linux user-agent', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
    expect(getPlatform()).toBe('desktop');
  });

  test('returns unknown for an unrecognized user-agent', () => {
    setUserAgent('CustomBot/1.0');
    expect(getPlatform()).toBe('unknown');
  });

  test('iOS check wins over the Mac substring (iPhone first in regex)', () => {
    setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    );
    expect(getPlatform()).toBe('ios');
  });
});

describe('supportsDeepLinking', () => {
  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  test('true on iOS / Android', () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)');
    expect(supportsDeepLinking()).toBe(true);
    setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)');
    expect(supportsDeepLinking()).toBe(true);
  });

  test('false on desktop / unknown', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)');
    expect(supportsDeepLinking()).toBe(false);
    setUserAgent('CustomBot/1.0');
    expect(supportsDeepLinking()).toBe(false);
  });
});
