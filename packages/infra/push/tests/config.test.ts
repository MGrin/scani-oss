import { beforeEach, describe, expect, test } from 'bun:test';
import { loadPushConfig, resetPushConfig, resolveVapid } from '../src/config';

/**
 * The configuration half of SC-226, and the case that matters is the partial
 * one: a public key with no private key lets a browser subscribe and stores an
 * endpoint nothing can ever send to. The user is told notifications are on and
 * never hears anything again, which is exactly the absence-that-reads-as-
 * success class in `docs/technical/2026-08-15_absence-and-refusal.md`.
 */

const SUBJECT = 'mailto:ops@scani.xyz';
const PUBLIC_KEY = 'BJxc0Fake_public_key_material_for_tests_only';
const PRIVATE_KEY = 'fake_private_key_material_for_tests_only';

beforeEach(() => {
  resetPushConfig();
});

describe('resolveVapid', () => {
  test('all three present resolves', () => {
    const result = resolveVapid({
      VAPID_SUBJECT: SUBJECT,
      VAPID_PUBLIC_KEY: PUBLIC_KEY,
      VAPID_PRIVATE_KEY: PRIVATE_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.details.publicKey).toBe(PUBLIC_KEY);
    expect(result.details.subject).toBe(SUBJECT);
  });

  test('nothing set names all three, so an operator can act on the log line', () => {
    const result = resolveVapid({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing.sort()).toEqual([
      'VAPID_PRIVATE_KEY',
      'VAPID_PUBLIC_KEY',
      'VAPID_SUBJECT',
    ]);
  });

  test('a public key WITHOUT a private key does not resolve', () => {
    // The dangerous half-configuration: subscribing would succeed and every
    // send would fail, silently, forever.
    const result = resolveVapid({ VAPID_SUBJECT: SUBJECT, VAPID_PUBLIC_KEY: PUBLIC_KEY });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['VAPID_PRIVATE_KEY']);
  });

  test('keys without a subject do not resolve', () => {
    const result = resolveVapid({ VAPID_PUBLIC_KEY: PUBLIC_KEY, VAPID_PRIVATE_KEY: PRIVATE_KEY });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['VAPID_SUBJECT']);
  });
});

describe('loadPushConfig', () => {
  test('rejects a subject that is neither mailto: nor https:', () => {
    // Push services answer a bare email address with a 400 at send time, which
    // is hours after the deploy and attributed to the wrong thing.
    expect(() => loadPushConfig({ VAPID_SUBJECT: 'ops@scani.xyz' })).toThrow(/VAPID_SUBJECT/);
  });

  test('accepts an https subject', () => {
    expect(loadPushConfig({ VAPID_SUBJECT: 'https://scani.xyz' }).VAPID_SUBJECT).toBe(
      'https://scani.xyz'
    );
  });

  test('caches, and reset clears it', () => {
    expect(loadPushConfig({ VAPID_SUBJECT: SUBJECT }).VAPID_SUBJECT).toBe(SUBJECT);
    expect(loadPushConfig({}).VAPID_SUBJECT).toBe(SUBJECT);

    resetPushConfig();
    expect(loadPushConfig({}).VAPID_SUBJECT).toBeUndefined();
  });
});
