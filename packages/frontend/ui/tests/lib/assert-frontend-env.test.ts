import { describe, expect, test } from 'bun:test';
import { assertFrontendEnv } from '../../src/lib/assert-frontend-env';

/**
 * SC-467: `allowSameOriginPath`, and the reason it is per-spec.
 *
 * The published `scani/frontend-app` image is built with `VITE_API_URL=/api`
 * so one artefact serves any hostname. `new URL('/api')` throws, so this
 * function threw during module evaluation of `main.tsx` and every published
 * build rendered a blank page — no error boundary above it, no network request
 * to look at, one console line. Measured against `scani/frontend-app:0.13.0`
 * on 2026-08-21.
 */

const PROD = { isProduction: true };

describe('allowSameOriginPath', () => {
  test('accepts the value the published image is built with', () => {
    expect(() =>
      assertFrontendEnv(
        [{ name: 'VITE_API_URL', value: '/api', required: true, allowSameOriginPath: true }],
        PROD
      )
    ).not.toThrow();
  });

  test('still rejects it without the flag', () => {
    // The flag has to be worth something. If a relative value passed for every
    // spec, `VITE_SENTRY_DSN=/oops` would become a silent no-op instead of a
    // misconfiguration.
    expect(() =>
      assertFrontendEnv([{ name: 'VITE_SENTRY_DSN', value: '/oops', required: true }], PROD)
    ).toThrow(/must be a valid URL/);
  });

  test('a protocol-relative URL is NOT a same-origin path', () => {
    // `//evil.example` resolves against the page's protocol to a DIFFERENT
    // origin. It looks relative and is not, so the `startsWith('//')` guard
    // keeps it out of the relative branch. It then fails `new URL()` for want
    // of a base — the message says "must be a valid URL", not "must use
    // https:", and the refusal is what this test is about.
    expect(() =>
      assertFrontendEnv(
        [
          {
            name: 'VITE_API_URL',
            value: '//evil.example/api',
            required: true,
            allowSameOriginPath: true,
          },
        ],
        PROD
      )
    ).toThrow(/Frontend env misconfigured/);
  });

  test('an absolute URL is still checked for protocol', () => {
    // The relative branch must not become a way past the https rule.
    expect(() =>
      assertFrontendEnv(
        [
          {
            name: 'VITE_API_URL',
            value: 'http://api.example.com',
            required: true,
            allowSameOriginPath: true,
          },
        ],
        PROD
      )
    ).toThrow(/must use one of https:/);
  });

  test('the flag does not make a missing value acceptable', () => {
    expect(() =>
      assertFrontendEnv(
        [{ name: 'VITE_API_URL', value: undefined, required: true, allowSameOriginPath: true }],
        PROD
      )
    ).toThrow(/required in production/);
  });
});

describe('the checks that already existed still fire', () => {
  test('https is required in production', () => {
    expect(() =>
      assertFrontendEnv([{ name: 'VITE_API_URL', value: 'http://x.test', required: true }], PROD)
    ).toThrow(/must use one of https:/);
  });

  test('a well-formed production value passes', () => {
    expect(() =>
      assertFrontendEnv(
        [{ name: 'VITE_API_URL', value: 'https://api.scani.xyz', required: true }],
        PROD
      )
    ).not.toThrow();
  });

  test('dev warns rather than throwing', () => {
    expect(() =>
      assertFrontendEnv([{ name: 'VITE_API_URL', value: 'not a url', required: true }], {
        isProduction: false,
      })
    ).not.toThrow();
  });
});
