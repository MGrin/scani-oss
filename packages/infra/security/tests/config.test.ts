import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadSecurityConfig, resetSecurityConfig } from '../src/config';

const originalKey = process.env.ENCRYPTION_KEY;
const originalNodeEnv = process.env.NODE_ENV;

describe('loadSecurityConfig', () => {
  beforeEach(() => {
    resetSecurityConfig();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    resetSecurityConfig();
  });

  test('accepts an unset key in dev/test', () => {
    delete process.env.ENCRYPTION_KEY;
    const cfg = loadSecurityConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(cfg.ENCRYPTION_KEY).toBeUndefined();
  });

  test('accepts a non-empty key in dev/test', () => {
    const cfg = loadSecurityConfig({
      NODE_ENV: 'development',
      ENCRYPTION_KEY: 'short-dev-key',
    } as NodeJS.ProcessEnv);
    expect(cfg.ENCRYPTION_KEY).toBe('short-dev-key');
  });

  test('rejects an empty key in dev/test (treat empty string as misconfig)', () => {
    expect(() =>
      loadSecurityConfig({ NODE_ENV: 'development', ENCRYPTION_KEY: '' } as NodeJS.ProcessEnv)
    ).toThrow(/@scani\/security env misconfigured/);
  });

  test('caches the parsed value across calls', () => {
    const a = loadSecurityConfig({
      NODE_ENV: 'development',
      ENCRYPTION_KEY: 'first',
    } as NodeJS.ProcessEnv);
    // Subsequent call with a different env returns the cached value because
    // we never reset between them — same shape as @scani/email's pattern.
    const b = loadSecurityConfig({
      NODE_ENV: 'development',
      ENCRYPTION_KEY: 'second',
    } as NodeJS.ProcessEnv);
    expect(a).toBe(b);
    expect(b.ENCRYPTION_KEY).toBe('first');
  });

  test('resetSecurityConfig clears the cache', () => {
    loadSecurityConfig({
      NODE_ENV: 'development',
      ENCRYPTION_KEY: 'first',
    } as NodeJS.ProcessEnv);
    resetSecurityConfig();
    const cfg = loadSecurityConfig({
      NODE_ENV: 'development',
      ENCRYPTION_KEY: 'second',
    } as NodeJS.ProcessEnv);
    expect(cfg.ENCRYPTION_KEY).toBe('second');
  });
});

// The production-required branch lives in @scani/config's `isNodeEnvProduction()`
// call evaluated at module load time, so we can't toggle NODE_ENV per-test
// without re-importing the schema. The contract is exercised in dev mode
// above and at app boot in production environments.
