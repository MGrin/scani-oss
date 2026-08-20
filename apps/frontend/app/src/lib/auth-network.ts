/**
 * Deadlines and failure wording for every call to the auth server.
 *
 * The defect this exists for (SC-78 §1) only happens on the installed PWA, and
 * it is the worst shape a defect can take there: with the api unreachable,
 * "Continue with Email" spun for over two minutes with the form disabled, no
 * error and no recovery — and in `display-mode: standalone` there is no reload
 * button and no URL bar, so force-quitting from the app switcher was the only
 * way out of the app's FIRST screen.
 *
 * The cause is that nothing in the chain has a deadline. `fetch` to a host that
 * accepts no connection does not fail promptly on iOS; it sits in connect
 * until the system gives up, which is far longer than any person will wait, and
 * better-auth's client simply awaits it. So every auth request now carries two:
 *
 * - `AUTH_FETCH_TIMEOUT_MS` aborts the underlying request. This is the real
 *   fix — an aborted fetch settles, so the promise the screen is awaiting
 *   settles too.
 * - `AUTH_CALL_TIMEOUT_MS` bounds the *call*, slightly later. It is not
 *   redundant: the abort only settles the fetch, and a client that swallows an
 *   `AbortError` while retrying internally would still hang the caller. The
 *   screen's spinner is what we are actually promising to stop, so the promise
 *   the screen holds is where the last-resort deadline belongs.
 *
 * Wording is derived from a classified failure rather than from whatever string
 * the transport produced. "Failed to fetch" is true and useless; what a reader
 * on a phone needs is which of the two things is wrong — their connection or
 * our server — and what to do next.
 */

import type { TFunction } from 'i18next';

/** Long enough for a cold Fly machine to answer, short enough that nobody
 *  believes the app is broken. Both numbers are per attempt. */
export const AUTH_FETCH_TIMEOUT_MS = 12_000;

/** The backstop, deliberately after the fetch deadline: if the abort worked,
 *  this never fires. */
export const AUTH_CALL_TIMEOUT_MS = 15_000;

export class AuthTimeoutError extends Error {
  constructor(message = 'The auth request timed out') {
    super(message);
    this.name = 'AuthTimeoutError';
  }
}

/** What went wrong, in the only four flavours a sign-in screen can act on. */
export type AuthFailureKind = 'offline' | 'timeout' | 'unreachable' | 'server';

/** Connectivity failures are the ones worth retrying by themselves — the
 *  server rejecting a code is not going to change when the wifi comes back. */
export function isConnectivityFailure(kind: AuthFailureKind): boolean {
  return kind !== 'server';
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof AuthTimeoutError) return true;
  if (error instanceof DOMException)
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  if (error instanceof Error) return error.name === 'AbortError' || error.name === 'TimeoutError';
  return false;
}

function isTransportFailure(error: unknown): boolean {
  // A cross-origin fetch that never reaches the server rejects with a bare
  // `TypeError`, and better-auth surfaces its own shape with status 0.
  if (error instanceof TypeError) return true;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return (error as { status?: unknown }).status === 0;
  }
  return false;
}

/**
 * Which failure this is. `online` is passed in rather than read from
 * `navigator` so the classification is a pure function of its inputs.
 *
 * Being offline outranks everything, including a timeout: the timeout is what
 * the offline state *causes*, and "check your connection" is the actionable
 * half of both.
 */
export function classifyAuthFailure(error: unknown, online: boolean): AuthFailureKind {
  if (!online) return 'offline';
  if (isAbortLike(error)) return 'timeout';
  if (isTransportFailure(error)) return 'unreachable';
  return 'server';
}

/**
 * What the screen says. Every message names the next action, because an error
 * with no next action on a screen with no back button is the wedge again in
 * slower motion.
 *
 * `t` is passed in rather than taken from a hook (SC-405). This is a lib
 * module, so it has no hook to take one from — and the alternative, returning a
 * key for the screen to resolve, would put the `server` case's fallback on the
 * wrong side of the boundary: only this function knows whether the server sent
 * a usable message, and that message arrives already worded by the server.
 */
export function authFailureMessage(
  t: TFunction,
  kind: AuthFailureKind,
  serverMessage?: string
): string {
  switch (kind) {
    case 'offline':
      return t('auth.failure.offline');
    case 'timeout':
      return t('auth.failure.timeout');
    case 'unreachable':
      return t('auth.failure.unreachable');
    case 'server':
      return serverMessage?.trim() || t('auth.failure.server');
  }
}

/**
 * `fetch` with an abort deadline, installed as better-auth's `customFetchImpl`
 * so it covers every auth call including the session probe on cold start.
 *
 * A caller's own `signal` is honoured as well as the deadline — whichever
 * fires first wins.
 */
export function fetchWithDeadline(
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs: number = AUTH_FETCH_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AuthTimeoutError()), timeoutMs);

  const caller = init?.signal;
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener('abort', () => controller.abort(caller.reason), { once: true });
  }

  return fetchImpl(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

/**
 * Bounds a promise. Rejects with `AuthTimeoutError` if the deadline passes
 * first; the underlying work is left to finish or not, since by then nothing
 * is waiting on it.
 */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AuthTimeoutError()), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** `navigator.onLine`, defensively — it is absent under the test runner and
 *  "we do not know" has to mean online, or every call would refuse to start. */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
