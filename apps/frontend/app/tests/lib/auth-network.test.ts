import { describe, expect, test } from 'bun:test';
import {
  AUTH_CALL_TIMEOUT_MS,
  AUTH_FETCH_TIMEOUT_MS,
  AuthTimeoutError,
  authFailureMessage,
  classifyAuthFailure,
  fetchWithDeadline,
  isConnectivityFailure,
  withDeadline,
} from '@/lib/auth-network';

/**
 * SC-78 §1: on the installed PWA with the api down, "Continue with Email" spun
 * for over two minutes with the form disabled, no error, and — in
 * `display-mode: standalone`, where there is no reload button and no URL bar —
 * no way out but force-quitting from the app switcher.
 *
 * Everything below is the guarantee that cannot be reasoned about at the call
 * site: a request that never answers still settles, and what the reader is then
 * told names the next tap.
 */

describe('deadlines', () => {
  test('the call deadline is after the fetch deadline, so the abort gets to win', () => {
    expect(AUTH_CALL_TIMEOUT_MS).toBeGreaterThan(AUTH_FETCH_TIMEOUT_MS);
  });

  test('a promise that never settles is rejected by the deadline', async () => {
    const never = new Promise<string>(() => {});
    await expect(withDeadline(never, 5)).rejects.toBeInstanceOf(AuthTimeoutError);
  });

  test('a promise that answers in time is untouched', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  test('a rejection passes through as itself, not as a timeout', async () => {
    const boom = new Error('boom');
    await expect(withDeadline(Promise.reject(boom), 50)).rejects.toBe(boom);
  });

  test('a fetch that hangs is aborted rather than awaited forever', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    await expect(
      fetchWithDeadline('https://api.example/x', undefined, 5, hanging)
    ).rejects.toBeInstanceOf(AuthTimeoutError);
  });

  test("a caller's own abort still works alongside the deadline", async () => {
    const controller = new AbortController();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const inFlight = fetchWithDeadline(
      'https://api.example/x',
      { signal: controller.signal },
      10_000,
      hanging
    );
    controller.abort();
    await expect(inFlight).rejects.toThrow('aborted');
  });
});

describe('classifying an auth failure', () => {
  test('offline outranks everything — it is the cause, and the actionable half', () => {
    expect(classifyAuthFailure(new AuthTimeoutError(), false)).toBe('offline');
    expect(classifyAuthFailure(new TypeError('Failed to fetch'), false)).toBe('offline');
    expect(classifyAuthFailure({ message: 'Invalid code' }, false)).toBe('offline');
  });

  test('an abort or a timeout while online is a timeout', () => {
    expect(classifyAuthFailure(new AuthTimeoutError(), true)).toBe('timeout');
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(classifyAuthFailure(aborted, true)).toBe('timeout');
  });

  test('a request that never reached the server is `unreachable`', () => {
    expect(classifyAuthFailure(new TypeError('Failed to fetch'), true)).toBe('unreachable');
    expect(classifyAuthFailure({ status: 0, message: 'Failed to fetch' }, true)).toBe(
      'unreachable'
    );
  });

  test('anything the server actually answered with is `server`', () => {
    expect(classifyAuthFailure({ status: 429, message: 'Too many requests' }, true)).toBe('server');
    expect(classifyAuthFailure(new Error('Invalid code'), true)).toBe('server');
  });

  test('only the connectivity kinds are worth retrying by themselves', () => {
    expect(isConnectivityFailure('offline')).toBe(true);
    expect(isConnectivityFailure('timeout')).toBe(true);
    expect(isConnectivityFailure('unreachable')).toBe(true);
    // A rejected code will still be rejected when the wifi is back.
    expect(isConnectivityFailure('server')).toBe(false);
  });
});

describe('what the reader is told', () => {
  test('every connectivity message names the next thing to do', () => {
    expect(authFailureMessage('offline')).toMatch(/offline/i);
    expect(authFailureMessage('timeout')).toMatch(/tap Continue again/);
    expect(authFailureMessage('unreachable')).toMatch(/tap Continue again/);
  });

  test("the server's own wording is kept when it has any", () => {
    expect(authFailureMessage('server', 'Invalid code')).toBe('Invalid code');
  });

  test('an empty server message still produces a sentence, never a blank alert', () => {
    expect(authFailureMessage('server', '   ')).toBe('Something went wrong. Try again.');
    expect(authFailureMessage('server')).toBe('Something went wrong. Try again.');
  });
});
