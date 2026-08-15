import { describe, expect, test } from 'bun:test';
import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import {
  buildCorsOrigins,
  buildTrustedOrigins,
  LOOPBACK_ORIGIN,
} from '../../src/config/browser-origins';

const FRONTEND = 'http://localhost:5173';
const PROD_FRONTEND = 'https://app.scani.xyz';

const PROD = { isProduction: true };
const DEV = { isProduction: false };

describe('LOOPBACK_ORIGIN', () => {
  test.each([
    'http://localhost:5173',
    'http://localhost',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4173',
    'http://[::1]:5173',
    'https://localhost:5173',
  ])('matches %s', (origin) => {
    expect(LOOPBACK_ORIGIN.test(origin)).toBe(true);
  });

  test.each([
    'https://app.scani.xyz',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://evil.example',
    'http://192.168.0.10:5173',
    'http://localhost:5173/path',
    'null',
  ])('does not match %s', (origin) => {
    expect(LOOPBACK_ORIGIN.test(origin)).toBe(false);
  });
});

describe('buildCorsOrigins', () => {
  test('production is exactly FRONTEND_URL and nothing else', () => {
    expect(buildCorsOrigins(PROD_FRONTEND, PROD)).toEqual([PROD_FRONTEND]);
  });

  test('development adds the loopback pattern', () => {
    expect(buildCorsOrigins(FRONTEND, DEV)).toEqual([FRONTEND, LOOPBACK_ORIGIN]);
  });
});

describe('buildTrustedOrigins', () => {
  test('production is exactly FRONTEND_URL and nothing else', () => {
    expect(buildTrustedOrigins(PROD_FRONTEND, PROD)).toEqual([PROD_FRONTEND]);
  });

  test('development adds loopback glob patterns, none of which is a bare wildcard', () => {
    const origins = buildTrustedOrigins(FRONTEND, DEV);
    expect(origins[0]).toBe(FRONTEND);
    expect(origins).toContain('http://127.0.0.1:*');
    for (const pattern of origins) {
      expect(pattern).not.toBe('*');
      expect(pattern).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|app\.scani)/);
    }
  });
});

/**
 * These exercise the real `@elysiajs/cors` plugin rather than the origin list
 * alone. The bug this file guards against was diagnosed three times as "the
 * plugin never emits a header", from `curl` runs that sent no `Origin` at all —
 * which correctly produces no `Access-Control-Allow-Origin`. Asserting both the
 * with-Origin and without-Origin cases keeps that misreading from recurring.
 */
function buildApp(frontendUrl: string, opts: { isProduction: boolean }): Elysia {
  return new Elysia()
    .use(
      cors({
        origin: buildCorsOrigins(frontendUrl, opts),
        credentials: true,
        allowedHeaders: ['Authorization', 'Content-Type'],
      })
    )
    .get('/health', () => ({ status: 'ok' }));
}

async function allowOriginFor(
  app: Elysia,
  origin: string | undefined,
  init: RequestInit = {}
): Promise<string | null> {
  const headers = new Headers(init.headers);
  if (origin !== undefined) headers.set('Origin', origin);
  const res = await app.handle(new Request('http://api.test/health', { ...init, headers }));
  return res.headers.get('access-control-allow-origin');
}

describe('CORS responses in production', () => {
  const app = buildApp(PROD_FRONTEND, PROD);

  test('the configured frontend origin is allowed', async () => {
    expect(await allowOriginFor(app, PROD_FRONTEND)).toBe(PROD_FRONTEND);
  });

  test('a disallowed origin is refused', async () => {
    expect(await allowOriginFor(app, 'https://evil.example')).toBeNull();
  });

  test('loopback is refused — the dev allowance never reaches production', async () => {
    expect(await allowOriginFor(app, 'http://localhost:5173')).toBeNull();
    expect(await allowOriginFor(app, 'http://127.0.0.1:5173')).toBeNull();
  });

  test('a request with no Origin gets no allow-origin header', async () => {
    expect(await allowOriginFor(app, undefined)).toBeNull();
  });

  test('preflight from the configured origin is answered', async () => {
    const res = await app.handle(
      new Request('http://api.test/health', {
        method: 'OPTIONS',
        headers: { Origin: PROD_FRONTEND, 'Access-Control-Request-Method': 'POST' },
      })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(PROD_FRONTEND);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('preflight from a disallowed origin carries no allow-origin header', async () => {
    const res = await app.handle(
      new Request('http://api.test/health', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
      })
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('CORS responses in development', () => {
  const app = buildApp(FRONTEND, DEV);

  test.each([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4173',
  ])('allows loopback origin %s', async (origin) => {
    expect(await allowOriginFor(app, origin)).toBe(origin);
  });

  test('a disallowed origin is still refused', async () => {
    expect(await allowOriginFor(app, 'https://evil.example')).toBeNull();
  });

  test('a lookalike hostname is refused', async () => {
    expect(await allowOriginFor(app, 'http://localhost.evil.example')).toBeNull();
  });
});
