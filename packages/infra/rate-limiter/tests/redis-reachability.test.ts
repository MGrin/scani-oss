/**
 * SC-225. On 2026-08-15 one `scani-backend` machine came back from a deploy
 * recycle emitting
 *
 *   [ioredis] Unhandled error event: DNSException: getaddrinfo ENOTFOUND
 *
 * every ~2s while its sibling was entirely healthy. `/health/deep` alternated
 * 502-after-31s and 200-in-0.7s depending on which the load balancer chose,
 * and `fly machine restart` fixed it instantly.
 *
 * **Established from ioredis 5.10.1's own source, not from documentation:**
 *
 *   - `StandaloneConnector.connect` hands `options.host` to
 *     `net.createConnection` on every attempt — nothing is cached, so the
 *     ticket's "retries a cached dead name" hypothesis is false.
 *   - `closeHandler` reconnects while `retryStrategy` returns a number, and
 *     the default `Math.min(times * 50, 2000)` always does. It never gives
 *     up, and 2000 ms is exactly the observed cadence.
 *   - `Redis.js:532` logs `[ioredis] Unhandled error event:` **only when
 *     `listeners('error').length === 0`** — the spam was ioredis reporting
 *     that nobody was listening.
 *
 * So there is nothing to fix in ioredis: it re-resolves every 2s and the name
 * genuinely does not resolve from that machine. What was missing is that
 * nothing observed it. These tests pin the observation.
 */
import { describe, expect, test } from 'bun:test';
import {
  createReachabilityTracker,
  isNameResolutionError,
  observeRedisReachability,
  type ReachabilityLogger,
  type RedisEventSource,
} from '../src/redis-reachability';

function dnsError(): Error & { code: string; syscall: string } {
  return Object.assign(new Error('getaddrinfo ENOTFOUND scani-worker.internal'), {
    code: 'ENOTFOUND',
    syscall: 'getaddrinfo',
  });
}

function connectionError(): Error & { code: string } {
  return Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
}

describe('isNameResolutionError', () => {
  test('separates "cannot look the host up" from "cannot connect to it"', () => {
    // The whole point: one recovers on its own, the other never does.
    expect(isNameResolutionError(dnsError())).toBe(true);
    expect(isNameResolutionError(Object.assign(new Error('x'), { code: 'EAI_AGAIN' }))).toBe(true);
    expect(isNameResolutionError(connectionError())).toBe(false);
    expect(isNameResolutionError(new Error('no code at all'))).toBe(false);
    expect(isNameResolutionError(null)).toBe(false);
  });
});

describe('createReachabilityTracker', () => {
  const t = (ms: number) => new Date(Date.parse('2026-08-15T17:04:00Z') + ms);

  test('a healthy client reports ok and nothing else', () => {
    expect(createReachabilityTracker().snapshot(t(0))).toEqual({ state: 'ok' });
  });

  test('the production shape: ENOTFOUND every 2s is measured, not just logged', () => {
    const tracker = createReachabilityTracker();

    tracker.onError(dnsError(), t(0));
    for (let i = 1; i <= 5; i += 1) tracker.onError(dnsError(), t(i * 2000));
    const state = tracker.snapshot(t(10_000));

    expect(state.state).toBe('unreachable');
    if (state.state !== 'unreachable') throw new Error('unreachable');
    expect(state.since).toEqual(t(0));
    expect(state.unreachableForMs).toBe(10_000);
    expect(state.consecutiveErrors).toBe(6);
    expect(state.lastErrorCode).toBe('ENOTFOUND');
    // The finding a human has to act on.
    expect(state.nameResolutionFailure).toBe(true);
  });

  test('an ordinary connection failure is NOT reported as a resolver failure', () => {
    // A worker deploy looks like this, and it recovers on its own. Reporting
    // it identically to a broken resolver is what made three hours of the
    // latter look like a deploy in progress.
    const tracker = createReachabilityTracker();

    tracker.onError(connectionError(), t(0));
    const state = tracker.snapshot(t(4000));

    expect(state.state).toBe('unreachable');
    if (state.state !== 'unreachable') throw new Error('unreachable');
    expect(state.nameResolutionFailure).toBe(false);
    expect(state.lastErrorCode).toBe('ECONNREFUSED');
  });

  test('a DNS failure latches across a mixed burst', () => {
    // A later ECONNREFUSED in the same outage does not make the resolver
    // healthy; only an actual connection does.
    const tracker = createReachabilityTracker();

    tracker.onError(dnsError(), t(0));
    tracker.onError(connectionError(), t(2000));
    const state = tracker.snapshot(t(2000));

    if (state.state !== 'unreachable') throw new Error('unreachable');
    expect(state.nameResolutionFailure).toBe(true);
  });

  test('a connection clears everything, including the latch', () => {
    const tracker = createReachabilityTracker();
    tracker.onError(dnsError(), t(0));

    tracker.onReady(t(5000));

    expect(tracker.snapshot(t(6000))).toEqual({ state: 'ok' });
  });

  test('a second outage measures from its own start, not the first', () => {
    const tracker = createReachabilityTracker();
    tracker.onError(dnsError(), t(0));
    tracker.onReady(t(1000));

    tracker.onError(connectionError(), t(9000));
    const state = tracker.snapshot(t(10_000));

    if (state.state !== 'unreachable') throw new Error('unreachable');
    expect(state.unreachableForMs).toBe(1000);
    expect(state.consecutiveErrors).toBe(1);
  });
});

describe('observeRedisReachability', () => {
  function fakeClient() {
    const handlers = new Map<string, (arg?: unknown) => void>();
    return {
      client: {
        on: (event: string, fn: (arg?: never) => void): void => {
          handlers.set(event, fn as (arg?: unknown) => void);
        },
      } as RedisEventSource,
      emit: (event: string, arg?: unknown) => handlers.get(event)?.(arg),
      listening: (event: string) => handlers.has(event),
    };
  }

  function recordingLogger() {
    const lines: Array<{ level: string; message: string; payload: Record<string, unknown> }> = [];
    const push = (level: string) => (payload: Record<string, unknown>, message: string) =>
      void lines.push({ level, message, payload });
    return {
      lines,
      logger: {
        warn: push('warn'),
        error: push('error'),
        info: push('info'),
      } as ReachabilityLogger,
    };
  }

  test("it attaches an error listener, which is what silences ioredis's console", () => {
    // `Redis.js:532` only logs when `listeners('error').length === 0`, so the
    // attachment IS the fix for the two-second spam.
    const { client, listening } = fakeClient();

    observeRedisReachability(client, recordingLogger().logger);

    expect(listening('error')).toBe(true);
    expect(listening('ready')).toBe(true);
  });

  test('a resolver failure logs at error ONCE, not every two seconds', () => {
    const { client, emit } = fakeClient();
    const { lines, logger } = recordingLogger();
    observeRedisReachability(client, logger);

    for (let i = 0; i < 20; i += 1) emit('error', dnsError());

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toContain('will not self-heal');
    expect(lines[0]?.payload.nameResolutionFailure).toBe(true);
  });

  test('an ordinary outage logs at warn, because it does recover', () => {
    const { client, emit } = fakeClient();
    const { lines, logger } = recordingLogger();
    observeRedisReachability(client, logger);

    emit('error', connectionError());

    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.message).toContain('retrying');
  });

  test('recovery is announced once, with how long it lasted', () => {
    const { client, emit } = fakeClient();
    const { lines, logger } = recordingLogger();
    const observer = observeRedisReachability(client, logger);

    emit('error', dnsError());
    emit('ready');

    expect(observer.current().state).toBe('ok');
    expect(lines).toHaveLength(2);
    expect(lines[1]?.level).toBe('info');
    expect(lines[1]?.message).toBe('Redis reachable again');
    expect(lines[1]?.payload.consecutiveErrors).toBe(1);
  });

  test('a healthy client that never errors logs nothing at all', () => {
    const { client, emit } = fakeClient();
    const { lines, logger } = recordingLogger();
    observeRedisReachability(client, logger);

    emit('ready');

    expect(lines).toHaveLength(0);
  });
});
