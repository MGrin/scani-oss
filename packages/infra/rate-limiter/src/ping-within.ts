/**
 * A Redis PING that is allowed to take a bounded amount of time (SC-294).
 *
 * ioredis queues a command issued while the connection is down and resolves it
 * whenever the connection returns — which, on a machine whose Redis host does
 * not resolve, is never. An unbounded `await redis.ping()` inside a health
 * endpoint therefore does not fail; it *hangs*, until whatever is in front of
 * it gives up. In production that was Fly's proxy at ~31s, returning a 502
 * with no body.
 *
 * The cost of that was not the latency. `/health/deep` reports
 * `redisReachability`, whose entire job is to say which kind of unreachable
 * this is — and it had never once been read during an occurrence, because the
 * deploy smoke fetches its diagnostic body with `curl --max-time 10`. The
 * endpoint carrying the diagnosis could not deliver it during the exact
 * failure it describes.
 *
 * A bound turns that into a 503 with the field in it, inside the deadline of
 * every reader.
 */
export interface PingableRedis {
  ping(): Promise<string>;
}

export class RedisPingTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`ping timed out after ${timeoutMs}ms`);
    this.name = 'RedisPingTimeoutError';
  }
}

/**
 * Resolves with the PING reply, or rejects with `RedisPingTimeoutError`.
 *
 * The timer is `unref`'d so a pending ping cannot hold the process open, and
 * cleared on the winning path so a burst of health checks does not accumulate
 * timers. The losing promise is left with a no-op catch rather than unhandled:
 * ioredis will settle it eventually, and an unhandled rejection arriving
 * minutes later — attributed to nothing — is its own debugging problem.
 */
export async function pingWithin(redis: PingableRedis, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ping = redis.ping();
  ping.catch(() => undefined);

  try {
    return await Promise.race([
      ping,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RedisPingTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
