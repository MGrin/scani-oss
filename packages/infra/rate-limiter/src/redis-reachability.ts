/**
 * What the shared Redis connection is currently doing, and for how long
 * (SC-225).
 *
 * ## Why this exists, established from ioredis 5.10.1's own source
 *
 * The ticket's hypothesis — that ioredis retries a cached dead DNS answer —
 * is **false**, and this module is what is left once that is ruled out:
 *
 *  - `StandaloneConnector.connect` passes `options.host` straight to
 *    `net.createConnection` on every attempt. Nothing is cached, so there is
 *    no stale answer to invalidate.
 *  - `closeHandler` reconnects for as long as `retryStrategy` returns a
 *    number, and the default is `Math.min(times * 50, 2000)` — a number
 *    always. **It never gives up**, and the 2000 ms ceiling is exactly the
 *    ~2s reconnect cadence this is observed at.
 *
 * So a client emitting `ENOTFOUND` every ~2s is re-resolving every ~2s and
 * genuinely failing. There is nothing in ioredis to fix: the name does not
 * resolve *from that machine*, while a sibling machine resolves it fine, and
 * only replacing the machine clears it. That is a property of the host's
 * resolver, not of this client — which is why `fly machine restart` fixes it
 * instantly and why a restart into a window where the name was not yet
 * resolvable can produce it.
 *
 * What we can do from in here is stop being silent about it.
 *
 * ## The console spam is the tell
 *
 * `[ioredis] Unhandled error event:` comes from `Redis.js:532`, and that
 * branch runs **only when `this.listeners('error').length === 0`**. The
 * production log line was ioredis reporting that nobody was listening.
 * Attaching a listener both silences the 2-second spam and is the only place
 * this state can be observed.
 *
 * ## The distinction that matters
 *
 * `ENOTFOUND`/`EAI_AGAIN` is **name resolution** — this machine cannot look
 * the host up, and no amount of waiting inside this process fixes it.
 * Everything else (`ECONNREFUSED`, timeouts) is **Redis being down or
 * restarting**, which does recover on its own and is the ordinary case during
 * a worker deploy. Reporting them identically is what made a broken resolver
 * look like a deploy in progress for three hours.
 */
export type RedisReachability =
  | { readonly state: 'ok' }
  | {
      readonly state: 'unreachable';
      /** When the current run of failures began. */
      readonly since: Date;
      readonly unreachableForMs: number;
      readonly consecutiveErrors: number;
      readonly lastError: string;
      readonly lastErrorCode?: string;
      /**
       * True when the failure is name resolution rather than connection.
       * This is the one a human has to act on: the process cannot recover
       * from it, so the machine has to be replaced.
       */
      readonly nameResolutionFailure: boolean;
    };

/** Node/libuv codes that mean "the host name could not be resolved". */
const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);

export function isNameResolutionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DNS_ERROR_CODES.has(code);
}

/**
 * The state machine, separated from the socket so it can be tested without
 * one — a reconnection path is otherwise only reachable by breaking DNS on
 * the host, which no test can do.
 */
export function createReachabilityTracker(): {
  onError: (error: unknown, now?: Date) => RedisReachability;
  onReady: (now?: Date) => RedisReachability;
  snapshot: (now?: Date) => RedisReachability;
} {
  let since: Date | null = null;
  let consecutiveErrors = 0;
  let lastError = '';
  let lastErrorCode: string | undefined;
  let nameResolutionFailure = false;

  const snapshot = (now: Date = new Date()): RedisReachability => {
    if (since === null) return { state: 'ok' };
    return {
      state: 'unreachable',
      since,
      unreachableForMs: Math.max(0, now.getTime() - since.getTime()),
      consecutiveErrors,
      lastError,
      ...(lastErrorCode ? { lastErrorCode } : {}),
      nameResolutionFailure,
    };
  };

  return {
    onError(error: unknown, now: Date = new Date()): RedisReachability {
      if (since === null) since = now;
      consecutiveErrors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      lastErrorCode = typeof code === 'string' ? code : undefined;
      // Latches for the run: one DNS failure in a burst is the finding, and
      // a later ECONNREFUSED in the same outage does not make the resolver
      // healthy again. Cleared only by an actual connection.
      nameResolutionFailure = nameResolutionFailure || isNameResolutionError(error);
      return snapshot(now);
    },
    onReady(now: Date = new Date()): RedisReachability {
      since = null;
      consecutiveErrors = 0;
      lastError = '';
      lastErrorCode = undefined;
      nameResolutionFailure = false;
      return snapshot(now);
    },
    snapshot,
  };
}

export interface ReachabilityLogger {
  warn: (payload: Record<string, unknown>, message: string) => void;
  error: (payload: Record<string, unknown>, message: string) => void;
  info: (payload: Record<string, unknown>, message: string) => void;
}

/**
 * The slice of a Redis client this needs — deliberately not `Pick<Redis,'on'>`,
 * whose overloads make the observer impossible to exercise without a socket.
 * The contract is two events, and a test can honour it.
 */
export interface RedisEventSource {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
}

/**
 * Attach the tracker to a live client.
 *
 * Logs on the **transitions** rather than on every error: the production
 * symptom was a line every two seconds for three hours, which is how it came
 * to be scrolled past. One line entering the state, one leaving it with a
 * duration.
 */
export function observeRedisReachability(
  client: RedisEventSource,
  logger: ReachabilityLogger,
  label = 'redis'
): { current: (now?: Date) => RedisReachability } {
  const tracker = createReachabilityTracker();
  let announced = false;

  client.on('error', (error: unknown) => {
    const state = tracker.onError(error);
    if (state.state !== 'unreachable' || announced) return;
    announced = true;
    const payload = {
      label,
      code: state.lastErrorCode,
      error: state.lastError,
      nameResolutionFailure: state.nameResolutionFailure,
    };
    if (state.nameResolutionFailure) {
      // Deliberately `error`: this one does not recover on its own. ioredis
      // will re-resolve every 2s forever and keep getting the same answer,
      // so the machine has to be replaced.
      logger.error(
        payload,
        'Redis host does not resolve from this machine — this will not self-heal; replace the machine'
      );
    } else {
      logger.warn(payload, 'Redis unreachable — retrying');
    }
  });

  client.on('ready', () => {
    const before = tracker.snapshot();
    tracker.onReady();
    if (!announced) return;
    announced = false;
    logger.info(
      {
        label,
        unreachableForMs: before.state === 'unreachable' ? before.unreachableForMs : 0,
        consecutiveErrors: before.state === 'unreachable' ? before.consecutiveErrors : 0,
      },
      'Redis reachable again'
    );
  });

  return { current: (now?: Date) => tracker.snapshot(now) };
}
