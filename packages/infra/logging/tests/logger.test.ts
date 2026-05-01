import { describe, expect, test } from 'bun:test';
import {
  createComponentLogger,
  createTimer,
  generateRequestId,
  logConfig,
  logger,
  sanitizeUrl,
} from '../src/index';

describe('sanitizeUrl', () => {
  test.each([
    ['https://api.example.com/v1?token=secret123', 'token=%5BREDACTED%5D'],
    ['https://api.example.com/v1?api_key=abc', 'api_key=%5BREDACTED%5D'],
    ['https://api.example.com/v1?apikey=xyz', 'apikey=%5BREDACTED%5D'],
    ['https://api.example.com/v1?key=foo', 'key=%5BREDACTED%5D'],
    ['https://api.example.com/v1?secret=bar', 'secret=%5BREDACTED%5D'],
    ['https://api.example.com/v1?password=baz', 'password=%5BREDACTED%5D'],
    ['https://api.example.com/v1?authorization=Bearer+x', 'authorization=%5BREDACTED%5D'],
  ])('redacts %s → contains %s', (input, expectedFragment) => {
    expect(sanitizeUrl(input)).toContain(expectedFragment);
  });

  test('preserves URLs with no sensitive params', () => {
    const url = 'https://api.example.com/v1?page=1&limit=10';
    expect(sanitizeUrl(url)).toBe(url);
  });

  test('redacts multiple sensitive params in one URL', () => {
    const result = sanitizeUrl('https://api.example.com/?token=a&api_key=b&page=1');
    expect(result).toContain('token=%5BREDACTED%5D');
    expect(result).toContain('api_key=%5BREDACTED%5D');
    expect(result).toContain('page=1');
  });

  test('falls back to regex when URL is not parseable (relative path)', () => {
    const result = sanitizeUrl('/v1/things?token=secret&page=1');
    expect(result).toBe('/v1/things?token=[REDACTED]&page=1');
  });

  test('handles empty query string', () => {
    expect(sanitizeUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  test('handles malformed URL gracefully (regex fallback)', () => {
    const result = sanitizeUrl('definitely?not=a&token=leaked&url');
    expect(result).toContain('token=[REDACTED]');
  });
});

describe('generateRequestId', () => {
  test('returns a non-empty string', () => {
    const id = generateRequestId();
    expect(id).toBeString();
    expect(id.length).toBeGreaterThan(0);
  });

  test('returns base36 chars only', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  test('returns unique values across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateRequestId()));
    expect(ids.size).toBe(1000);
  });
});

describe('createTimer', () => {
  test('returns a positive elapsed time', async () => {
    const t = createTimer();
    await Bun.sleep(5);
    expect(t.end()).toBeGreaterThan(0);
  });

  test('measures in milliseconds', async () => {
    const t = createTimer();
    await Bun.sleep(20);
    const ms = t.end();
    // Generous bounds — sleep timing is approximate, but we should be in
    // the right order of magnitude (ms, not ns or s).
    expect(ms).toBeGreaterThanOrEqual(15);
    expect(ms).toBeLessThan(200);
  });

  test('end() can be called repeatedly', () => {
    const t = createTimer();
    const a = t.end();
    const b = t.end();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('createComponentLogger', () => {
  test('returns a logger with a child binding', () => {
    const log = createComponentLogger('test-component');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  test('child loggers inherit pino methods', () => {
    const log = createComponentLogger('billing');
    expect(typeof log.child).toBe('function');
    expect(typeof log.level).toBe('string');
  });

  test('does not throw when called with structured context', () => {
    const log = createComponentLogger('test-no-throw');
    expect(() => log.info({ userId: 'u1' }, 'message')).not.toThrow();
    expect(() => log.warn('plain string')).not.toThrow();
    expect(() => log.error({ err: new Error('boom') }, 'failed')).not.toThrow();
  });
});

describe('logger', () => {
  test('exposes the standard pino level methods', () => {
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });
});

describe('logConfig', () => {
  test('reflects test-mode defaults (NODE_ENV !== production)', () => {
    expect(logConfig.level).toBeString();
    expect(typeof logConfig.pretty).toBe('boolean');
    expect(typeof logConfig.timestamp).toBe('boolean');
    expect(typeof logConfig.logSqlQueries).toBe('boolean');
  });
});
