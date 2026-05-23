import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { addBreadcrumb, captureException, flushSentry, initSentry } from '../src/sentry';

// All assertions in this file run with SENTRY_DSN unset (the test default),
// so every helper short-circuits via its `initialized` guard. We're proving
// the safety-net contract: nothing throws, nothing observably happens,
// regardless of payload shape.

describe('Sentry helpers (SENTRY_DSN unset)', () => {
  let originalDsn: string | undefined;

  beforeEach(() => {
    originalDsn = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
  });

  test('initSentry is a no-op when SENTRY_DSN is unset', () => {
    expect(() => initSentry({ component: 'worker' })).not.toThrow();
  });

  test('captureException no-ops without throwing when not initialized', () => {
    expect(() => captureException(new Error('boom'))).not.toThrow();
    expect(() => captureException('string error', { foo: 'bar' })).not.toThrow();
    expect(() => captureException({ unusual: 'shape' })).not.toThrow();
    expect(() => captureException(null)).not.toThrow();
  });

  test('addBreadcrumb no-ops without throwing when not initialized', () => {
    expect(() =>
      addBreadcrumb({
        category: 'cloud-client',
        message: 'POST /trpc/pricing',
        level: 'info',
        data: { status: 200, durationMs: 42 },
      })
    ).not.toThrow();
  });

  test('addBreadcrumb accepts the minimum payload shape', () => {
    expect(() => addBreadcrumb({ category: 'test' })).not.toThrow();
  });

  test('flushSentry resolves immediately when not initialized', async () => {
    const start = Date.now();
    await flushSentry(5000);
    // Should be near-instant since the function returns early on the
    // !initialized branch. 100ms is a generous upper bound.
    expect(Date.now() - start).toBeLessThan(100);
  });

  test('flushSentry resolves with a custom timeout', async () => {
    await expect(flushSentry(100)).resolves.toBeUndefined();
  });
});

describe('initSentry idempotence', () => {
  test('a second initSentry call without DSN remains a no-op', () => {
    expect(() => initSentry({ component: 'backend' })).not.toThrow();
    expect(() => initSentry({ component: 'data-provider' })).not.toThrow();
  });
});
