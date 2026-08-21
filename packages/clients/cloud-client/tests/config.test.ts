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
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    resetCloudClientConfig();
  });

  describe('in production', () => {
    beforeEach(() => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
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

    test('missing API key is rejected in production', () => {
      // This used to be untestable: `requiredInProd` resolves
      // required-vs-optional at MODULE LOAD, so in a `test`-mode bun run the
      // key was always optional and the assertion could not be written. The
      // production rules moved onto the object (SC-516) and read NODE_ENV at
      // parse time, which is what makes this reachable.
      expect(() =>
        loadCloudClientConfig({
          NODE_ENV: 'production',
          SCANI_CLOUD_URL: 'https://hosted.example.com',
        } as NodeJS.ProcessEnv)
      ).toThrow(/SCANI_CLOUD_API_KEY.*is required in production/s);
    });
  });

  // SC-516 — `demo.scani.xyz` has no data-provider, because it prices
  // nothing, syncs nothing and mails nobody. The carve-out is by NAME and
  // narrow, and these tests exist in both directions: the ones that prove it
  // fires, and the ones that prove it does NOT.
  describe('in production, with SCANI_DEMO_MODE=1', () => {
    beforeEach(() => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    });

    test('both variables may be absent', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'production',
        SCANI_DEMO_MODE: '1',
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBeUndefined();
      expect(cfg.SCANI_CLOUD_API_KEY).toBeUndefined();
    });

    test('a demo carrying a production cloud URL is STILL rejected', () => {
      // The test a future reader will want to delete, because "demo mode
      // exempts these variables" reads as "demo mode stops looking at them".
      // It does not, and the difference is the whole point: a demo holding
      // `http://api.cloud.scani.xyz` did not get there by being configured —
      // it got there by being copied from production, which is the case
      // `scripts/lib/demo-isolation.ts` exists for. Exempting a variable when
      // it is ABSENT and ignoring it when it is PRESENT are different rules,
      // and only the first one is safe.
      expect(() =>
        loadCloudClientConfig({
          NODE_ENV: 'production',
          SCANI_DEMO_MODE: '1',
          SCANI_CLOUD_URL: 'http://api.cloud.scani.xyz',
          SCANI_CLOUD_API_KEY: 'a'.repeat(16),
        } as NodeJS.ProcessEnv)
      ).toThrow(/must use https:\/\/ in production/);
    });

    test('a demo that DOES set both is accepted unchanged', () => {
      const cfg = loadCloudClientConfig({
        NODE_ENV: 'production',
        SCANI_DEMO_MODE: '1',
        SCANI_CLOUD_URL: 'http://scani-demo-data-provider.internal:8082',
        SCANI_CLOUD_API_KEY: 'a'.repeat(16),
      } as NodeJS.ProcessEnv);
      expect(cfg.SCANI_CLOUD_URL).toBe('http://scani-demo-data-provider.internal:8082');
    });

    test.each([
      'true',
      '0',
      '',
      'yes',
      undefined,
    ])('SCANI_DEMO_MODE=%p does NOT exempt anything', (value) => {
      // The exactness of `=== '1'` is the security property, and the
      // carve-out inherits it. A near-miss spelling must fail closed —
      // otherwise a typo'd flag on a real instance would silently turn the
      // production requirement off.
      expect(() =>
        loadCloudClientConfig({
          NODE_ENV: 'production',
          ...(value === undefined ? {} : { SCANI_DEMO_MODE: value }),
        } as NodeJS.ProcessEnv)
      ).toThrow(/SCANI_CLOUD_URL.*is required in production/s);
    });
  });

  describe('in development', () => {
    beforeEach(() => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
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
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
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
