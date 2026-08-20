import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  canToggle,
  type PushEnvironment,
  pushAvailability,
  pushTestLines,
  urlBase64ToUint8Array,
} from '../../../src/v3/lib/push';

/**
 * The rule this file exists for (SC-226): never offer the control where it
 * cannot work, and never show a permission prompt that silently does nothing.
 */

function env(overrides: Partial<PushEnvironment> = {}): PushEnvironment {
  return {
    hasServiceWorker: true,
    hasPushManager: true,
    permission: 'default',
    platform: 'android',
    isInstalled: true,
    serverConfigured: true,
    subscribed: false,
    ...overrides,
  };
}

describe('pushAvailability', () => {
  test('a capable, configured, unsubscribed browser is ready', () => {
    expect(pushAvailability(env())).toBe('ready');
  });

  test('already subscribed reads as enabled', () => {
    expect(pushAvailability(env({ subscribed: true, permission: 'granted' }))).toBe('enabled');
  });

  test('iOS in a browser tab needs the app installed first', () => {
    // Safari exposes PushManager in a tab and subscribing still fails: Web
    // Push on iOS is Home-Screen-only (16.4+). Offering the toggle here means
    // offering a permission prompt that does nothing.
    expect(pushAvailability(env({ platform: 'ios', isInstalled: false }))).toBe(
      'ios-needs-install'
    );
  });

  test('iOS as an installed PWA is ready — this is mgrin`s own case', () => {
    expect(pushAvailability(env({ platform: 'ios', isInstalled: true }))).toBe('ready');
  });

  test('a server with no VAPID keys reports ITS OWN refusal, ahead of the install advice', () => {
    // Otherwise a missing key on our side is dressed up as a fault with the
    // user's phone, and the operator never learns which it was.
    expect(
      pushAvailability(env({ serverConfigured: false, platform: 'ios', isInstalled: false }))
    ).toBe('server-unconfigured');
  });

  test('a denied permission is named, not hidden behind a dead toggle', () => {
    expect(pushAvailability(env({ permission: 'denied' }))).toBe('denied');
  });

  test('no service worker, no Push API, or no Notification API is unsupported', () => {
    expect(pushAvailability(env({ hasServiceWorker: false }))).toBe('unsupported');
    expect(pushAvailability(env({ hasPushManager: false }))).toBe('unsupported');
    expect(pushAvailability(env({ permission: null }))).toBe('unsupported');
  });
});

describe('canToggle', () => {
  test('only ready and enabled are actionable', () => {
    expect(canToggle('ready')).toBe(true);
    expect(canToggle('enabled')).toBe(true);
    for (const state of ['server-unconfigured', 'ios-needs-install', 'unsupported', 'denied']) {
      expect(canToggle(state as never)).toBe(false);
    }
  });
});

describe('urlBase64ToUint8Array', () => {
  test('decodes a VAPID-length key to 65 bytes starting with 0x04', () => {
    // An uncompressed P-256 point: 65 bytes, leading 0x04 (SEC 1 §2.3.3).
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    for (let i = 1; i < 65; i += 1) raw[i] = i;
    const base64Url = btoa(String.fromCharCode(...raw))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const decoded = urlBase64ToUint8Array(base64Url);

    expect(decoded.length).toBe(65);
    expect(decoded[0]).toBe(0x04);
    expect(Array.from(decoded)).toEqual(Array.from(raw));
  });

  test('base64url substitutions are undone, not passed through', () => {
    // `-`/`_` are not `+`/`/`. Handing the raw value to `atob` throws
    // `InvalidCharacterError`, which surfaces as a failed subscribe with no
    // mention of the key that caused it — hence the substitution here.
    const withSubstitutions = 'a-b_cw==';

    expect(() => atob(withSubstitutions)).toThrow();

    const decoded = urlBase64ToUint8Array('a-b_cw');
    expect(Array.from(decoded)).toEqual(
      Array.from(
        new Uint8Array(
          atob('a+b/cw')
            .split('')
            .map((c) => c.charCodeAt(0))
        )
      )
    );
  });

  test('restores stripped padding', () => {
    // base64url drops `=`; `atob` rejects the unpadded string outright.
    expect(() => urlBase64ToUint8Array('QUJD')).not.toThrow();
    expect(() => urlBase64ToUint8Array('QUJDRA')).not.toThrow();
  });
});

/**
 * The test send's report, turned into what the reader is shown (SC-322).
 *
 * The whole point of the feature is that four outcomes are different
 * sentences, and two of them — a dead subscription and a VAPID mismatch —
 * name a different person's problem. Ordering matters for the same reason the
 * reminder's own copy does: the reader is holding one device, and the line
 * about a laptop in another room is not the answer to "did it arrive".
 */
describe('pushTestLines', () => {
  const HERE = 'https://push.example/this-device';
  const THERE = 'https://push.example/other-device';

  test('marks the caller`s own device as here and lists it first', () => {
    const lines = pushTestLines(
      [
        { endpoint: THERE, outcome: { status: 'sent' } },
        { endpoint: HERE, outcome: { status: 'sent' } },
      ],
      HERE
    );

    expect(lines).toEqual([
      { endpoint: HERE, status: 'sent', here: true, statusCode: null },
      { endpoint: THERE, status: 'sent', here: false, statusCode: null },
    ]);
  });

  test('a browser with no local subscription reports every device as elsewhere', () => {
    // Reading `here` off a null endpoint as a match would tell someone on a
    // laptop that a notification arrived on the device in front of them.
    const lines = pushTestLines([{ endpoint: HERE, outcome: { status: 'sent' } }], null);

    expect(lines).toEqual([{ endpoint: HERE, status: 'sent', here: false, statusCode: null }]);
  });

  test('keeps a failure`s status code so the sentence can name it', () => {
    const lines = pushTestLines(
      [{ endpoint: HERE, outcome: { status: 'failed', statusCode: 429 } }],
      HERE
    );

    expect(lines).toEqual([{ endpoint: HERE, status: 'failed', here: true, statusCode: 429 }]);
  });

  test('a failure with no code normalises to null rather than undefined', () => {
    const lines = pushTestLines([{ endpoint: HERE, outcome: { status: 'failed' } }], HERE);

    expect(lines).toEqual([{ endpoint: HERE, status: 'failed', here: true, statusCode: null }]);
  });

  test('preserves relative order among the devices that are not here', () => {
    const lines = pushTestLines(
      [
        { endpoint: THERE, outcome: { status: 'gone' } },
        { endpoint: 'https://push.example/third', outcome: { status: 'vapid-mismatch' } },
      ],
      HERE
    );

    expect(lines.map((l) => l.status)).toEqual(['gone', 'vapid-mismatch']);
  });
});
