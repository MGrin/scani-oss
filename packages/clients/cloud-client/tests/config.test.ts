import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isPrivateNetworkHost, loadCloudClientConfig, resetCloudClientConfig } from '../src/config';

describe('isPrivateNetworkHost', () => {
  test('compose-network service names (no dots) are private', () => {
    expect(isPrivateNetworkHost('data-provider')).toBe(true);
    expect(isPrivateNetworkHost('api')).toBe(true);
    expect(isPrivateNetworkHost('localhost')).toBe(true);
  });

  test('.internal and .local suffixes are private', () => {
    expect(isPrivateNetworkHost('data-provider.internal')).toBe(true);
    expect(isPrivateNetworkHost('mailhog.local')).toBe(true);
  });

  test('public hostnames are not private', () => {
    expect(isPrivateNetworkHost('data-provider.example.com')).toBe(false);
    expect(isPrivateNetworkHost('app.scani.xyz')).toBe(false);
    expect(isPrivateNetworkHost('hosted.your-host.example.com')).toBe(false);
  });
});

describe('loadCloudClientConfig — SCANI_CLOUD_URL schema', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    resetCloudClientConfig();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    resetCloudClientConfig();
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    test('https:// public hostname is accepted', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'production',
        SCANI_CLOUD_URL: 'https://hosted.example.com',
        SCANI_CLOUD_API_KEY: 'a'.repeat(16),
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBe('https://hosted.example.com');
    });

    test('http:// public hostname is rejected', () => {
      expect(() =>
        loadCloudClientConfig({
          NODE_ENV: 'production',
          SCANI_CLOUD_URL: 'http://hosted.example.com',
          SCANI_CLOUD_API_KEY: 'a'.repeat(16),
        } as NodeJS.ProcessEnv)
      ).toThrow(/must use https:\/\/ in production/);
    });

    test('http:// compose-network alias is accepted (the headline Tier 1 sentinel)', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'production',
        SCANI_CLOUD_URL: 'http://data-provider:8082',
        SCANI_CLOUD_API_KEY: 'a'.repeat(16),
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBe('http://data-provider:8082');
    });

    test('http://localhost is accepted (no dot)', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'production',
        SCANI_CLOUD_URL: 'http://localhost:8082',
        SCANI_CLOUD_API_KEY: 'a'.repeat(16),
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBe('http://localhost:8082');
    });

    test('http://*.internal is accepted', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'production',
        SCANI_CLOUD_URL: 'http://data-provider.internal',
        SCANI_CLOUD_API_KEY: 'a'.repeat(16),
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBe('http://data-provider.internal');
    });

    test('missing URL is rejected in production', () => {
      expect(() =>
        loadCloudClientConfig({
          NODE_ENV: 'production',
          SCANI_CLOUD_API_KEY: 'a'.repeat(16),
        } as NodeJS.ProcessEnv)
      ).toThrow(/SCANI_CLOUD_URL.*is required in production/s);
    });

    // NOTE on `SCANI_CLOUD_API_KEY` prod-required behaviour:
    // `requiredInProd` in @scani/config reads NODE_ENV at module-load time,
    // so its required-vs-optional resolution is frozen to whatever NODE_ENV
    // the test process started with (typically `test`). The runtime guard
    // works correctly in real production boot — it just can't be exercised
    // from a `test`-mode bun run without refactoring `requiredInProd` to
    // read NODE_ENV at parse time too. The URL behaviour we own here (the
    // http://-for-private-hosts rule) does read NODE_ENV at parse time and
    // is fully covered above.
  });

  describe('in development', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    test('SCANI_CLOUD_URL can be unset', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBeUndefined();
    });

    test('http://data-provider:8082 is accepted (the dev default)', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'development',
        SCANI_CLOUD_URL: 'http://data-provider:8082',
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBe('http://data-provider:8082');
    });

    test('https://hosted.example.com is accepted', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'development',
        SCANI_CLOUD_URL: 'https://hosted.example.com',
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBe('https://hosted.example.com');
    });
  });

  // N-1 regression sentinel — `bun build --compile --minify` statically
  // inlines literal `process.env.NODE_ENV` accesses with the build-time
  // value ("development" when unset), silently making every prod guard
  // dead. The schema MUST read NODE_ENV via bracket notation so the
  // runtime OS env is honoured. This test sets NODE_ENV via bracket
  // notation (mirroring the compiled-binary path) and verifies the
  // public-hostname rejection still fires.
  test('runtime NODE_ENV (bracket access) still rejects http://public hostname', () => {
    // biome-ignore lint/complexity/useLiteralKeys: same bracket-notation form a compiled binary uses
    process.env['NODE_ENV'] = 'production';
    resetCloudClientConfig();
    expect(() =>
      loadCloudClientConfig({
        NODE_ENV: 'production',
        SCANI_CLOUD_URL: 'http://public.example.com',
        SCANI_CLOUD_API_KEY: 'a'.repeat(16),
      } as NodeJS.ProcessEnv)
    ).toThrow(/must use https:\/\/ in production/);
  });
});
