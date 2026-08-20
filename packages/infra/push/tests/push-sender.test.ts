import { beforeEach, describe, expect, test } from 'bun:test';
import { resetPushConfig } from '../src/config';
import { isSubscriptionGone, isVapidMismatch, PushSender } from '../src/push-sender';

const TARGET = { endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a' };
const PAYLOAD = { title: 'Scani', body: '5 payments due tomorrow · $500.00', url: '/payments' };

beforeEach(() => {
  resetPushConfig();
  delete process.env.VAPID_SUBJECT;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe('isSubscriptionGone', () => {
  test('404 and 410 mean the subscription is gone', () => {
    expect(isSubscriptionGone(404)).toBe(true);
    expect(isSubscriptionGone(410)).toBe(true);
  });

  test('403 is NOT gone — it is our own VAPID key that changed', () => {
    // Deleting on 403 would empty the whole table on the first deploy that
    // rotated the keypair, unsubscribing every user without telling any of
    // them (RFC 8292 §4).
    expect(isSubscriptionGone(403)).toBe(false);
  });

  test('transient and client-error codes are not gone', () => {
    for (const code of [400, 401, 413, 429, 500, 502, 503]) {
      expect(isSubscriptionGone(code)).toBe(false);
    }
  });

  test('a failure with no status code at all is not gone', () => {
    // A DNS failure or a socket reset carries no status. Treating "we could
    // not reach the push service" as "the user unsubscribed" would delete
    // every subscription during an outage.
    expect(isSubscriptionGone(undefined)).toBe(false);
  });
});

describe('isVapidMismatch', () => {
  test('403 is our own keypair, not the device', () => {
    expect(isVapidMismatch(403)).toBe(true);
  });

  test('the codes that mean the subscription is gone are not a mismatch', () => {
    // The two are exclusive and must stay so: one deletes a row, the other
    // says the deployment is misconfigured. Confusing them either
    // unsubscribes a live user or hides a keypair that can never deliver.
    expect(isVapidMismatch(404)).toBe(false);
    expect(isVapidMismatch(410)).toBe(false);
    expect(isSubscriptionGone(403)).toBe(false);
  });

  test('nothing else is a mismatch, including a failure with no code', () => {
    for (const code of [400, 401, 413, 429, 500, 502, 503]) {
      expect(isVapidMismatch(code)).toBe(false);
    }
    expect(isVapidMismatch(undefined)).toBe(false);
  });
});

describe('PushSender without VAPID keys', () => {
  test('reports itself unconfigured rather than pretending', () => {
    expect(new PushSender().isConfigured()).toBe(false);
  });

  test('publicKey is null, not an empty string', () => {
    // An empty string is the shape that reaches `pushManager.subscribe()` and
    // fails inside the browser, where the reason is invisible to us.
    expect(new PushSender().publicKey()).toBeNull();
  });

  test('send refuses by name and never touches the network', async () => {
    const result = await new PushSender().send(TARGET, PAYLOAD);

    expect(result.status).toBe('not-configured');
    if (result.status !== 'not-configured') throw new Error('unreachable');
    expect(result.missing.sort()).toEqual([
      'VAPID_PRIVATE_KEY',
      'VAPID_PUBLIC_KEY',
      'VAPID_SUBJECT',
    ]);
  });
});
