import { afterEach, describe, expect, test } from 'bun:test';
import { readLocalPushEndpoint } from '@/v3/lib/push-local';

/**
 * SC-1743. Settings waits for this read before it shows the Notifications
 * area, so it must answer. `serviceWorker.ready` never settles in a browser
 * with no active worker, and reading through it held the area, and the
 * Settings list's notifications row, in a loading state that never ended.
 */
const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'serviceWorker');

function installServiceWorker(container: unknown) {
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis.navigator, 'serviceWorker', original);
  else delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
});

const never = new Promise<never>(() => {});
const within = <T>(ms: number, promise: Promise<T>) =>
  Promise.race([promise, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), ms))]);

describe('readLocalPushEndpoint', () => {
  test('answers null when no worker is registered, even though `ready` never settles', async () => {
    installServiceWorker({ ready: never, getRegistration: async () => undefined });
    expect(await within(200, readLocalPushEndpoint())).toBeNull();
  });

  test("returns this browser's endpoint from the registration it already has", async () => {
    // The control: a subscribed browser still reads as subscribed.
    const registration = {
      pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/abc' }) },
    };
    installServiceWorker({ ready: never, getRegistration: async () => registration });
    expect(await within(200, readLocalPushEndpoint())).toBe('https://push.example/abc');
  });

  test('answers null when the registration holds no subscription', async () => {
    const registration = { pushManager: { getSubscription: async () => null } };
    installServiceWorker({
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
    });
    expect(await within(200, readLocalPushEndpoint())).toBeNull();
  });
});
