/**
 * Independent Reserve Rate Limiter Singleton
 *
 * Docs cap the Private API at ~1 request / second / key. We keep a small
 * headroom: 10 calls per 15 seconds, partitioned by credential via
 * `credentialBucketKey` when `executeWithRateLimit` is called with a subKey.
 */

import { RateLimiter } from '@scani/rate-limiter';

export const independentReserveRateLimiter = new RateLimiter(10, 15000, {
  namespace: 'independentReserve',
});
