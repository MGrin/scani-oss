/**
 * Notifications' pure half (SC-226): what this browser can actually do, and
 * the one byte-level conversion the Push API insists on.
 *
 * It lives here for the same reason every other v3 `lib/` module does — it is
 * a decision about what a set of capability flags MEANS, and it is the part a
 * test can hold without a DOM.
 */

export interface PushEnvironment {
  /** `'serviceWorker' in navigator`. */
  hasServiceWorker: boolean;
  /** `'PushManager' in window`. */
  hasPushManager: boolean;
  /** `Notification.permission`, or null when `Notification` is absent. */
  permission: NotificationPermission | null;
  platform: 'ios' | 'android' | 'desktop' | 'unknown';
  /** Running as an installed app rather than a browser tab. */
  isInstalled: boolean;
  /** The api reported a VAPID public key. */
  serverConfigured: boolean;
  /** This device already has a subscription stored server-side. */
  subscribed: boolean;
}

export type PushAvailability =
  /** Nothing can be offered: this deployment has no VAPID keys. */
  | 'server-unconfigured'
  /**
   * iOS in a browser tab. Safari exposes `PushManager` here and
   * `pushManager.subscribe()` still fails — Web Push on iOS 16.4+ is
   * available ONLY to a PWA added to the Home Screen. Showing a toggle would
   * mean showing a permission prompt that does nothing.
   */
  | 'ios-needs-install'
  /** No service worker or no Push API — nothing to offer. */
  | 'unsupported'
  /**
   * The user said no. The browser will not ask again from script, so the only
   * honest thing to show is where to undo it — a toggle that appears to work
   * and silently no-ops is worse than a sentence.
   */
  | 'denied'
  /** Subscribed on this device. */
  | 'enabled'
  /** Can be turned on right now, from a tap. */
  | 'ready';

/**
 * Order matters, and each rung is a different person's problem.
 *
 * The server's own refusal comes FIRST — before "install the app" — because
 * hiding a missing VAPID key behind an install prompt would send the operator
 * chasing the user's phone for a fault that is entirely ours. It is the
 * absence-vs-refusal rule applied to a UI: say which of the two it is.
 */
export function pushAvailability(env: PushEnvironment): PushAvailability {
  if (!env.serverConfigured) return 'server-unconfigured';
  if (env.platform === 'ios' && !env.isInstalled) return 'ios-needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || env.permission === null) {
    return 'unsupported';
  }
  if (env.permission === 'denied') return 'denied';
  if (env.subscribed) return 'enabled';
  return 'ready';
}

/** Only these two states mean the reader can act on the control. */
export function canToggle(availability: PushAvailability): boolean {
  return availability === 'ready' || availability === 'enabled';
}

/**
 * What one endpoint answered a test send (SC-322), mirroring the api's own
 * vocabulary in `SendTestNotificationUseCase`.
 */
export type PushTestStatus = 'sent' | 'gone' | 'vapid-mismatch' | 'failed';

/** The part of a reported device this module needs to decide what to say. */
export interface PushTestDevice {
  endpoint: string;
  outcome: { status: PushTestStatus; statusCode?: number | null };
}

export interface PushTestLine {
  /** Carried through as the line's identity — one line IS one endpoint. */
  endpoint: string;
  status: PushTestStatus;
  /** The device the reader is holding, rather than another one they own. */
  here: boolean;
  statusCode: number | null;
}

/**
 * The report, ordered and resolved against this browser's own subscription.
 *
 * `here` is the distinction the whole screen turns on: "sent to this device"
 * is an answer to "did it arrive", and "sent to a device in another room" is
 * not — and told wrongly it is worse than silence, because the reader waits
 * for a notification that was never addressed to them.
 *
 * This device first, and everything else in the order the server returned.
 */
export function pushTestLines(
  devices: PushTestDevice[],
  localEndpoint: string | null
): PushTestLine[] {
  const lines = devices.map((device) => ({
    endpoint: device.endpoint,
    status: device.outcome.status,
    // A null local endpoint means this browser holds no subscription, so
    // nothing here can be "this device" — never a match against null.
    here: localEndpoint !== null && device.endpoint === localEndpoint,
    statusCode: device.outcome.statusCode ?? null,
  }));
  return [...lines.filter((l) => l.here), ...lines.filter((l) => !l.here)];
}

/**
 * VAPID key, base64url text → the `BufferSource` `pushManager.subscribe()`
 * demands.
 *
 * `applicationServerKey` will not take a string in Firefox or older Chromium,
 * and the failure is a `DOMException` at subscribe time rather than anything a
 * type checker sees. base64url is not base64: `-`/`_` stand in for `+`/`/` and
 * the padding is dropped, so `atob` on the raw value throws
 * `InvalidCharacterError` — which reaches the user as "could not enable
 * notifications", naming nothing.
 */
export function urlBase64ToUint8Array(base64UrlString: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64UrlString.length % 4)) % 4);
  const base64 = (base64UrlString + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Backed by an explicit `ArrayBuffer` rather than `new Uint8Array(n)`, which
  // widens to `ArrayBufferLike` and is then not assignable to the
  // `BufferSource` that `applicationServerKey` takes.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
