import { afterEach, describe, expect, test } from 'bun:test';
import { loadDemoConfig, resetDemoConfig } from '../../src/config/demo';

/**
 * SC-466. The env layer of the demo guard — the cheap one that catches a
 * misconfiguration before it costs a boot. The layer that actually protects
 * production data is the database assertion; see
 * `packages/business/domain/src/demo/mode.ts`.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.SCANI_DEMO_MODE = ORIGINAL.SCANI_DEMO_MODE;
  process.env.SCANI_DEMO_SIGNUP_URL = ORIGINAL.SCANI_DEMO_SIGNUP_URL;
  if (ORIGINAL.SCANI_DEMO_MODE === undefined) delete process.env.SCANI_DEMO_MODE;
  if (ORIGINAL.SCANI_DEMO_SIGNUP_URL === undefined) delete process.env.SCANI_DEMO_SIGNUP_URL;
  resetDemoConfig();
});

describe('loadDemoConfig', () => {
  test('is off by default — an environment that says nothing is a normal deployment', () => {
    resetDemoConfig();
    expect(loadDemoConfig({}).enabled).toBe(false);
  });

  test('is on only for exactly "1"', () => {
    resetDemoConfig();
    expect(loadDemoConfig({ SCANI_DEMO_MODE: '1' }).enabled).toBe(true);
    resetDemoConfig();
    expect(loadDemoConfig({ SCANI_DEMO_MODE: 'true' }).enabled).toBe(false);
  });

  test('offers a real signup destination even when nobody configured one', () => {
    // A demo with no way out is the failure SC-450 measured, not a smaller
    // version of the feature.
    resetDemoConfig();
    const config = loadDemoConfig({ SCANI_DEMO_MODE: '1' });
    expect(config.signupUrl).toStartWith('https://');
  });

  test('a configured signup URL wins', () => {
    resetDemoConfig();
    expect(
      loadDemoConfig({ SCANI_DEMO_MODE: '1', SCANI_DEMO_SIGNUP_URL: 'https://app.example.com/x' })
        .signupUrl
    ).toBe('https://app.example.com/x');
  });

  test('a blank configured URL falls back rather than rendering a dead link', () => {
    resetDemoConfig();
    expect(loadDemoConfig({ SCANI_DEMO_MODE: '1', SCANI_DEMO_SIGNUP_URL: '  ' }).signupUrl).toBe(
      'https://app.scani.xyz'
    );
  });

  test('caches, so posture cannot change between two requests of one process', () => {
    resetDemoConfig();
    expect(loadDemoConfig({ SCANI_DEMO_MODE: '1' }).enabled).toBe(true);
    expect(loadDemoConfig({}).enabled).toBe(true);
  });
});
