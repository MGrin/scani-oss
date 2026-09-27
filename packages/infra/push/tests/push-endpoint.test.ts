import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import webpush from 'web-push';
import { resetPushConfig } from '../src/config';
import { isAllowedPushEndpoint } from '../src/push-endpoint';
import { PushSender } from '../src/push-sender';

// SC-1346: a subscription endpoint is a URL the api and worker later POST to,
// so any https URL made `push.test` a request to wherever the caller chose.

describe('isAllowedPushEndpoint', () => {
  test.each([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGf2xYp',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts the push service at %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  test.each([
    ['an internal Fly host', 'https://scani-worker.internal/'],
    ['a private address', 'https://10.0.0.5/push'],
    ['loopback', 'https://127.0.0.1/'],
    ['plain http to a push host', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a push host on another port', 'https://fcm.googleapis.com:6379/fcm/send/abc'],
    ['a lookalike suffix', 'https://fcm.googleapis.com.evil.example/x'],
    ['a lookalike prefix', 'https://evilnotify.windows.com/x'],
    ['credentials in the URL', 'https://user:pw@fcm.googleapis.com/fcm/send/abc'],
    ['not a URL', 'fcm.googleapis.com/abc'],
  ])('refuses %s', (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

describe('PushSender.send and the allowlist', () => {
  beforeEach(() => {
    resetPushConfig();
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_SUBJECT = 'mailto:test@scani.local';
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  });

  afterEach(() => {
    resetPushConfig();
    delete process.env.VAPID_SUBJECT;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  test('refuses a stored endpoint outside the allowlist without sending', async () => {
    const original = webpush.sendNotification;
    let calls = 0;
    webpush.sendNotification = (async () => {
      calls += 1;
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;
    try {
      const result = await new PushSender().send(
        { endpoint: 'https://scani-worker.internal:6379/', p256dh: 'p', auth: 'a' },
        { title: 'Scani', body: 'x', url: '/' }
      );
      expect(result).toEqual({ status: 'failed', reason: 'endpoint-not-allowed' });
      expect(calls).toBe(0);
    } finally {
      webpush.sendNotification = original;
    }
  });

  test('control: an allowed endpoint is sent, with a timeout', async () => {
    const original = webpush.sendNotification;
    let timeout: unknown;
    webpush.sendNotification = (async (_sub, _payload, options) => {
      timeout = options?.timeout;
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;
    try {
      const result = await new PushSender().send(
        { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'p', auth: 'a' },
        { title: 'Scani', body: 'x', url: '/' }
      );
      expect(result).toEqual({ status: 'sent' });
      expect(typeof timeout).toBe('number');
    } finally {
      webpush.sendNotification = original;
    }
  });
});
