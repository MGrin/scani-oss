import { withRedisTimeout } from '@scani/deadline';

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
 * Timer cleanup, `unref` and the no-op catch on the losing promise all live in
 * `withRedisTimeout` — see there for why each is load-bearing.
 */
export async function pingWithin(redis: PingableRedis, timeoutMs: number): Promise<string> {
  return withRedisTimeout(redis.ping(), timeoutMs, () => new RedisPingTimeoutError(timeoutMs));
}
