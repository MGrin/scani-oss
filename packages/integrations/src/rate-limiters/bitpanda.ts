import { RateLimiter } from '@scani/rate-limiter';

/** Bitpanda retail caps at ~600 req/minute per API key. Keep headroom. */
export const bitpandaRateLimiter = new RateLimiter(300, 60000, { namespace: 'bitpanda' });
