import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { resolveApiBaseUrl } from '../../src/lib/api-base-url';

/**
 * SC-467. The published `scani/frontend-app` image is built with
 * `VITE_API_URL=/api` so one artefact serves any hostname — a self-hoster's
 * box, `demo.scani.xyz`, a laptop. Better-Auth throws
 * `BetterAuthError: Invalid base URL: /api` on a relative value, during MODULE
 * evaluation, and that white-screened every published build: React never
 * mounts, `#root` stays empty, and the only signal anywhere is one console
 * line. Measured against `scani/frontend-app:0.13.0` on 2026-08-21.
 */

describe('resolveApiBaseUrl', () => {
  test('resolves the relative form the published image is built with', () => {
    expect(resolveApiBaseUrl('/api', 'https://demo.scani.xyz')).toBe('https://demo.scani.xyz/api');
    expect(resolveApiBaseUrl('/api', 'http://localhost:8087')).toBe('http://localhost:8087/api');
  });

  test('leaves an absolute URL alone', () => {
    // `app.scani.xyz` is built against a backend on a different origin, and
    // rewriting that to the page's own origin would point every auth request
    // at the SPA's host, which serves no API.
    expect(resolveApiBaseUrl('https://api.scani.xyz', 'https://app.scani.xyz')).toBe(
      'https://api.scani.xyz'
    );
    expect(resolveApiBaseUrl('http://localhost:3001', 'http://localhost:5173')).toBe(
      'http://localhost:3001'
    );
  });

  test('trailing slashes are stripped on both branches', () => {
    // Callers append `/trpc` and `/api/auth/...`; a double slash reaches the
    // server as a different path and nginx does not normalise it away.
    expect(resolveApiBaseUrl('https://api.scani.xyz/', 'https://app.scani.xyz')).toBe(
      'https://api.scani.xyz'
    );
    expect(resolveApiBaseUrl('/api/', 'https://demo.scani.xyz')).toBe('https://demo.scani.xyz/api');
  });

  test('still refuses an absent value', () => {
    // The loud failure this replaced was correct for the case it covered — a
    // build pipeline that forgot to stage the variable at all.
    expect(() => resolveApiBaseUrl(undefined, 'https://x.test')).toThrow(/VITE_API_URL/);
    expect(() => resolveApiBaseUrl('   ', 'https://x.test')).toThrow(/VITE_API_URL/);
  });

  test('a ws:// value is treated as absolute, not resolved', () => {
    // The scheme test is not `^https?://` on purpose: anything with a scheme
    // is somebody's deliberate absolute URL, and silently re-basing it against
    // the page origin would be worse than passing it through.
    expect(resolveApiBaseUrl('wss://api.scani.xyz', 'https://app.scani.xyz')).toBe(
      'wss://api.scani.xyz'
    );
  });
});

describe("the constraint is the library's, not an assumption about it", () => {
  // If Better-Auth ever accepted a relative base, the fix above would be
  // ceremony and this test would say so by failing. Measuring the library
  // rather than trusting the error message is the difference between knowing
  // why the fix is needed and having copied it from a stack trace.
  test('createAuthClient refuses the relative value and accepts the resolved one', async () => {
    const { createAuthClient } = await import('better-auth/react');
    expect(() => createAuthClient({ baseURL: '/api' })).toThrow(/base URL/i);
    expect(() =>
      createAuthClient({ baseURL: resolveApiBaseUrl('/api', 'https://demo.scani.xyz') })
    ).not.toThrow();
  });
});

describe('nothing reaches Better-Auth or WebSocket unresolved', () => {
  // The two call sites that cannot take a relative URL. A future edit that
  // reads `import.meta.env.VITE_API_URL` back into either of them restores a
  // white screen that no other test in this repo can see — `bun run test`
  // does not build the bundle, and the failure is a module-scope throw with
  // no network request and no rendered error.
  const ROOT = resolve(import.meta.dir, '..', '..');

  test('auth-client.ts resolves rather than reading the raw env', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/auth-client.ts'), 'utf8');
    expect(source).toContain('apiBaseUrl()');
    expect(source).not.toContain('import.meta.env.VITE_API_URL');
  });

  test('RealtimeContext.tsx resolves before building the ws URL', () => {
    const source = readFileSync(resolve(ROOT, 'src/contexts/RealtimeContext.tsx'), 'utf8');
    expect(source).toContain('apiBaseUrl()');
    expect(source).not.toMatch(/const apiUrl = import\.meta\.env\.VITE_API_URL/);
  });

  /**
   * The class, not the instance.
   *
   * A relative `VITE_API_URL` is fine for `fetch` and fatal for anything that
   * parses a URL. Two of the four readers in this app were fatal and nobody
   * had drawn that distinction, so the guard is an inventory: every raw read
   * is listed here with why it survives a relative value, and a new one fails
   * this test until somebody says which kind it is.
   *
   * That is deliberately more annoying than a rule the author could satisfy
   * without thinking. The whole failure was a value that looked usable
   * everywhere and was not.
   */
  const RAW_READS_ALLOWED: ReadonlyArray<{ file: string; because: string }> = [
    {
      file: 'src/main.tsx',
      because:
        'the assertFrontendEnv spec, which is given allowSameOriginPath and therefore accepts it',
    },
    {
      file: 'src/lib/report-client-error.ts',
      because: 'concatenated into a fetch() URL, and fetch resolves a relative path itself',
    },
    {
      file: 'src/lib/trpc-provider.tsx',
      because: "concatenated into httpBatchLink's url, which fetch resolves the same way",
    },
    {
      file: 'src/lib/api-base-url.ts',
      because: 'the resolver itself — this is the one place the raw value is meant to be read',
    },
  ];

  test('every file reading VITE_API_URL raw is one that can survive a relative value', () => {
    const listed = new Set(RAW_READS_ALLOWED.map((entry) => entry.file));
    const found = new Set<string>();

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (readFileSync(full, 'utf8').includes('import.meta.env.VITE_API_URL')) {
          found.add(relative(ROOT, full));
        }
      }
    };
    walk(resolve(ROOT, 'src'));

    // Both directions. An unlisted reader is the bug class returning; a listed
    // file that no longer reads it means this inventory has gone stale and is
    // quietly approving nothing.
    expect([...found].filter((file) => !listed.has(file)).sort()).toEqual([]);
    expect([...listed].filter((file) => !found.has(file)).sort()).toEqual([]);
  });
});
