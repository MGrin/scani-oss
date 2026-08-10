/**
 * Sentry noise filters shared by the Scani frontends.
 *
 * Two separate mechanisms, for two separate problems:
 *
 *   - `SENTRY_IGNORED_ERROR_PATTERNS` — errors we can enumerate by message.
 *     Feed it straight to `Sentry.init({ ignoreErrors })`.
 *   - `isThirdPartyOnlyStack` — the long tail of extension-injected crashes
 *     that rotate their messages faster than anyone can list them. Judged by
 *     stack, not text, from `beforeSend`.
 *
 * The bar for adding a pattern here is that the error is *not actionable from
 * our code*. Silencing a real regression is far more expensive than tolerating
 * a noisy issue, so every entry is anchored tightly enough that an application
 * error with similar wording still reports — `Failed to fetch portfolio` is
 * ours and must survive, `Failed to fetch` is the browser's and must not.
 *
 * Deliberately free of any `@sentry/*` import: this package is on the frontend
 * hot path and the types below are structural, so it stays dependency-free
 * (same reasoning as `sentry-scrubber.ts`).
 */

/** Minimal structural shape of the bits of a Sentry event we inspect. */
interface StackFrameLike {
  filename?: string;
  abs_path?: string;
}

interface EventLike {
  exception?: {
    values?: Array<{ stacktrace?: { frames?: StackFrameLike[] } }>;
  };
}

/**
 * A fetch that is aborted mid-flight — tab backgrounded, navigation
 * cancelled, cell network dropped — surfaces as a `TypeError` with a
 * different message in every engine, and none of them is distinguishable
 * from a real network failure at the message level.
 *
 * Dropping them is safe because these arrive as *unhandled rejections* from
 * the tRPC/React Query layer after the observer already unmounted. When a
 * request genuinely fails, the query's error state still renders in the UI,
 * and a real API outage is caught by the backend's own Sentry projects and
 * health checks rather than by the browser.
 */
const ABORTED_FETCH_PATTERNS: RegExp[] = [
  // Chromium — Chrome, Edge, Android WebView, Yandex. This is SCANI-FRONTEND-8.
  /^(TypeError: )?Failed to fetch$/,
  // WebKit — Safari, every iOS browser.
  /^(TypeError: )?Load failed$/,
  // Gecko — Firefox. Trailing period is present in some versions only.
  /^(TypeError: )?NetworkError when attempting to fetch resource\.?$/,
  // Safari's wording when a navigation cancels an in-flight request.
  /cancelled$/i,
];

/**
 * Errors injected by browser extensions and third-party SDKs we never import.
 */
const INJECTED_SCRIPT_PATTERNS: RegExp[] = [
  // Telegram Mini Apps / VK bridge SDKs injected by crypto-wallet extensions.
  // Surfaces inside a setTimeout frame from an anonymous extension script.
  /Error invoking postEvent/i,
  /postEvent.*Method not found/i,
  // Benign layout notification emitted as an uncaught error by many UI libs.
  /ResizeObserver loop/i,
];

/**
 * Pass directly to `Sentry.init({ ignoreErrors: SENTRY_IGNORED_ERROR_PATTERNS })`.
 */
export const SENTRY_IGNORED_ERROR_PATTERNS: (string | RegExp)[] = [
  ...ABORTED_FETCH_PATTERNS,
  ...INJECTED_SCRIPT_PATTERNS,
];

/**
 * Whether Sentry would drop `message` under the patterns above.
 *
 * Exported mainly so the patterns are testable without booting the SDK, but
 * also usable by any custom `beforeSend` that needs the same verdict.
 */
export function isIgnoredSentryMessage(message: string): boolean {
  if (!message) return false;
  return SENTRY_IGNORED_ERROR_PATTERNS.some((pattern) =>
    typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message)
  );
}

/** Frame URLs that are definitively not our application code. */
const THIRD_PARTY_FRAME_PATTERNS: RegExp[] = [
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
  /^safari-web-extension:\/\//,
  /^safari-extension:\/\//,
  /^webkit-masked-url:/,
];

/**
 * True only when every frame in the stack is third-party.
 *
 * Returns false whenever the answer is unknown — no stack, no frames, or
 * frames without a resolvable url. An event we cannot classify is an event we
 * report: the cost of dropping a real crash is much higher than the cost of
 * one noisy issue.
 */
export function isThirdPartyOnlyStack(event: unknown): boolean {
  const frames = (event as EventLike)?.exception?.values?.[0]?.stacktrace?.frames ?? [];
  if (frames.length === 0) return false;
  return frames.every((frame) => {
    const url = frame.abs_path || frame.filename || '';
    if (!url) return false;
    return THIRD_PARTY_FRAME_PATTERNS.some((pattern) => pattern.test(url));
  });
}
