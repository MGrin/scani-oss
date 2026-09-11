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
    ).toBe('https://app.example.com/x?src=demo');
  });

  test('a blank configured URL falls back rather than rendering a dead link', () => {
    resetDemoConfig();
    expect(loadDemoConfig({ SCANI_DEMO_MODE: '1', SCANI_DEMO_SIGNUP_URL: '  ' }).signupUrl).toBe(
      'https://app.scani.xyz/?src=demo'
    );
  });

  /**
   * SC-515. The demo is the one deployment that knows a click came from the
   * demo, so the tag is put on here rather than trusted to configuration.
   */
  describe('the signup link carries the funnel tag', () => {
    test('the default destination is tagged', () => {
      resetDemoConfig();
      expect(loadDemoConfig({ SCANI_DEMO_MODE: '1' }).signupUrl).toBe(
        'https://app.scani.xyz/?src=demo'
      );
    });

    test("a self-hoster's own app is tagged too — it says where the click came from, not whose app it went to", () => {
      resetDemoConfig();
      expect(
        loadDemoConfig({ SCANI_DEMO_MODE: '1', SCANI_DEMO_SIGNUP_URL: 'https://money.example.org' })
          .signupUrl
      ).toBe('https://money.example.org/?src=demo');
    });

    test('an existing query string survives', () => {
      resetDemoConfig();
      expect(
        loadDemoConfig({
          SCANI_DEMO_MODE: '1',
          SCANI_DEMO_SIGNUP_URL: 'https://app.example.com/join?ref=x',
        }).signupUrl
      ).toBe('https://app.example.com/join?ref=x&src=demo');
    });

    test('a configured tag is not overwritten', () => {
      resetDemoConfig();
      expect(
        loadDemoConfig({
          SCANI_DEMO_MODE: '1',
          SCANI_DEMO_SIGNUP_URL: 'https://app.example.com/?src=partner',
        }).signupUrl
      ).toBe('https://app.example.com/?src=partner');
    });

    test('an unparseable URL reaches the banner unchanged rather than becoming an error', () => {
      // Not this module's validation boundary, and a demo that refuses to boot
      // over a bad link is worse than one whose banner link does nothing.
      resetDemoConfig();
      expect(
        loadDemoConfig({ SCANI_DEMO_MODE: '1', SCANI_DEMO_SIGNUP_URL: 'not a url' }).signupUrl
      ).toBe('not a url');
    });
  });

  test('caches, so posture cannot change between two requests of one process', () => {
    resetDemoConfig();
    expect(loadDemoConfig({ SCANI_DEMO_MODE: '1' }).enabled).toBe(true);
    expect(loadDemoConfig({}).enabled).toBe(true);
  });
});
