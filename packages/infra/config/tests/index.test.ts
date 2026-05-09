import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  assertEnvIsolatedUrl,
  httpsUrlInProduction,
  isProduction,
  requiredInProd,
  urlSchema,
} from '../src/index';

function withNodeEnv(value: string) {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });
}

describe('isProduction', () => {
  test('is false under bun test (NODE_ENV !== "production")', () => {
    expect(isProduction).toBe(false);
  });
});

describe('urlSchema', () => {
  test.each([
    'http://example.com',
    'https://example.com',
    'https://example.com:8080/path?query=1',
    'postgres://user:pass@localhost:5432/db',
    'redis://localhost:6379',
  ])('accepts %s', (url) => {
    expect(urlSchema.safeParse(url).success).toBe(true);
  });

  test.each(['', 'not a url', 'example.com', '://no-scheme'])('rejects %s', (input) => {
    expect(urlSchema.safeParse(input).success).toBe(false);
  });

  test('uses the custom "must be a valid URL" error message', () => {
    const result = urlSchema.safeParse('garbage');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('must be a valid URL');
    }
  });

  test('rejects non-string input', () => {
    expect(urlSchema.safeParse(42).success).toBe(false);
    expect(urlSchema.safeParse(null).success).toBe(false);
    expect(urlSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('httpsUrlInProduction (dev mode)', () => {
  test('accepts http:// URLs', () => {
    expect(httpsUrlInProduction.safeParse('http://example.com').success).toBe(true);
  });

  test('accepts https:// URLs', () => {
    expect(httpsUrlInProduction.safeParse('https://example.com').success).toBe(true);
  });

  test('still rejects malformed URLs', () => {
    expect(httpsUrlInProduction.safeParse('not a url').success).toBe(false);
  });
});

describe('httpsUrlInProduction (production mode)', () => {
  withNodeEnv('production');

  test('rejects http:// URLs', () => {
    const result = httpsUrlInProduction.safeParse('http://example.com');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('must use https:// in production');
    }
  });

  test('accepts https:// URLs', () => {
    expect(httpsUrlInProduction.safeParse('https://example.com').success).toBe(true);
  });

  test('still rejects malformed URLs (urlSchema base check fires first)', () => {
    expect(httpsUrlInProduction.safeParse('not a url').success).toBe(false);
  });
});

describe('requiredInProd (dev mode)', () => {
  test('accepts undefined', () => {
    const schema = requiredInProd(z.string().min(8), 'API_KEY');
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  test('preserves the inner schema constraints when a value is provided', () => {
    const schema = requiredInProd(z.string().min(8), 'API_KEY');
    expect(schema.safeParse('short').success).toBe(false);
    expect(schema.safeParse('long enough value').success).toBe(true);
  });

  test('treats empty string as a value (not as missing)', () => {
    // Inner z.string().min(1) rejects '', .optional() only short-circuits on
    // undefined. This is zod's standard semantics; documenting it here so
    // future readers don't conflate "optional" with "required-but-allows-empty".
    const schema = requiredInProd(z.string().min(1), 'API_KEY');
    expect(schema.safeParse('').success).toBe(false);
  });

  test('works without varName', () => {
    const schema = requiredInProd(z.string().min(4));
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse('xxxx').success).toBe(true);
    expect(schema.safeParse('xx').success).toBe(false);
  });

  test('composes inside a larger object schema', () => {
    const env = z.object({
      OPTIONAL_KEY: requiredInProd(z.string().min(16), 'OPTIONAL_KEY'),
      REQUIRED_URL: urlSchema,
    });
    const result = env.safeParse({ REQUIRED_URL: 'https://example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.OPTIONAL_KEY).toBeUndefined();
      expect(result.data.REQUIRED_URL).toBe('https://example.com');
    }
  });
});

describe('requiredInProd (production mode)', () => {
  withNodeEnv('production');

  test('rejects undefined when varName is given (friendly named error)', () => {
    const schema = requiredInProd(z.string().min(8), 'API_KEY');
    const result = schema.safeParse(undefined);
    expect(result.success).toBe(false);
  });

  test('rejects empty string with the varName-tagged message', () => {
    const schema = requiredInProd(z.string(), 'API_KEY');
    const result = schema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'API_KEY is required in production and cannot be empty'
      );
    }
  });

  test('passes valid values through the inner schema constraints', () => {
    const schema = requiredInProd(z.string().min(16), 'API_KEY');
    expect(schema.safeParse('short').success).toBe(false);
    expect(schema.safeParse('long-enough-value-here').success).toBe(true);
  });

  test('without varName, the inner schema fires its own min() message', () => {
    const schema = requiredInProd(z.string().min(8));
    const result = schema.safeParse('short');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('too_small');
    }
  });

  test('composes inside a larger object schema and rejects missing keys', () => {
    const env = z.object({
      API_KEY: requiredInProd(z.string().min(16), 'API_KEY'),
      REQUIRED_URL: urlSchema,
    });
    const result = env.safeParse({ REQUIRED_URL: 'https://example.com' });
    expect(result.success).toBe(false);
  });
});

describe('assertEnvIsolatedUrl', () => {
  test('production rejects localhost / 127.0.0.1 / docker-host URLs', () => {
    const cases = [
      'redis://localhost:6379',
      'redis://127.0.0.1:6379',
      'postgres://0.0.0.0:5432/scani',
      'redis://host.docker.internal:6379',
    ];
    for (const url of cases) {
      expect(() => assertEnvIsolatedUrl({ url, varName: 'REDIS_URL', isProduction: true })).toThrow(
        /REDIS_URL/
      );
    }
  });

  test('production accepts remote vendor URLs (incl. port 6379)', () => {
    const cases = [
      'redis://default:secret@scani-prod.upstash.io:6380',
      // Real Upstash deployments commonly use port 6379 too — the
      // earlier `:6379` blanket-reject was a false-positive that
      // caused production boot crashes. Host-based detection only now.
      'rediss://default:secret@scani-prod.upstash.io:6379',
      'postgresql://scani:pw@ep-cool-noise-1.us-east-2.aws.neon.tech/scani',
    ];
    for (const url of cases) {
      expect(assertEnvIsolatedUrl({ url, varName: 'X', isProduction: true })).toBe(url);
    }
  });

  test('non-production rejects vendor URLs', () => {
    expect(() =>
      assertEnvIsolatedUrl({
        url: 'redis://default:secret@scani-prod.upstash.io:6380',
        varName: 'REDIS_URL',
        isProduction: false,
      })
    ).toThrow(/REDIS_URL/);
  });

  test('non-production accepts localhost URLs', () => {
    expect(
      assertEnvIsolatedUrl({
        url: 'redis://localhost:6380',
        varName: 'REDIS_URL',
        isProduction: false,
      })
    ).toBe('redis://localhost:6380');
  });

  test('allowCrossEnv opts out of the guard entirely', () => {
    expect(
      assertEnvIsolatedUrl({
        url: 'redis://default:secret@scani-prod.upstash.io:6380',
        varName: 'REDIS_URL',
        isProduction: false,
        allowCrossEnv: true,
      })
    ).toBe('redis://default:secret@scani-prod.upstash.io:6380');
  });

  test('error messages redact embedded credentials', () => {
    try {
      assertEnvIsolatedUrl({
        url: 'redis://user:supersecret@localhost:6379',
        varName: 'REDIS_URL',
        isProduction: true,
      });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('supersecret');
      expect(msg).toContain('<redacted>');
    }
  });
});
