/**
 * IBKR Flex Query rate limiter.
 *
 * IBKR's Flex Web Service rate limit is enforced **per token**:
 * `SendRequest` on the same token within a short window returns error
 * code 1018 ("Too many requests have been made from this token"). The
 * exact window isn't publicly documented but empirical testing + IBKR
 * support consistently cite ~15 seconds between SendRequests on the same
 * token. A single GetStatement poll against a reference code is cheaper
 * — but the backoff is driven by SendRequest frequency.
 *
 * Ref:
 *   - https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/
 *   - IBKR error-code table: 1018 = request frequency too high.
 *
 * We combine this singleton's limit with a per-credential subKey (see
 * `RateLimiter.execute(fn, subKey)`) so two different tokens don't
 * share a bucket — one user can't block another's IBKR traffic in Scani.
 */

import { RateLimiter } from '@scani/rate-limiter';

export const ibkrRateLimiter = new RateLimiter(1, 15000, { namespace: 'ibkr' });
