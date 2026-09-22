/**
 * A cap on the cloud console's sign-in traffic (SC-1260).
 *
 * Every request counted here sends an email or creates an account, and until
 * 2026-09-19 nothing limited them: the api has had a per-IP signup limiter
 * since launch, the data-provider's `/api/auth` forward had none, and scripted
 * signups turned it into a bounce generator. Two budgets, checked in order:
 * per IP, then one shared by everybody, so a caller rotating addresses still
 * runs out. The global one can lock real users out for up to an hour — the
 * accepted cost, because the alternative is mail nobody can stop.
 */

import { createInflowLimiter } from '@scani/rate-limiter';
import type { Redis } from 'ioredis';

const HOUR_MS = 60 * 60 * 1000;

const SENDING_PREFIXES = [
  '/api/auth/sign-in',
  '/api/auth/sign-up',
  '/api/auth/email-otp/send-verification-otp',
  '/api/auth/forget-password',
  '/api/auth/change-email',
];

export function isCloudAuthSend(method: string, pathname: string): boolean {
  return method === 'POST' && SENDING_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function createCloudAuthGate(
  redis: Redis | null,
  limits: { perIpPerHour: number; globalPerHour: number } = { perIpPerHour: 6, globalPerHour: 60 }
): (request: Request) => Promise<Response | null> {
  const perIp = createInflowLimiter(redis, {
    windowMs: HOUR_MS,
    max: limits.perIpPerHour,
    namespace: 'rl:cloud-auth',
  });
  const everyone = createInflowLimiter(redis, {
    windowMs: HOUR_MS,
    max: limits.globalPerHour,
    namespace: 'rl:cloud-auth-global',
  });

  return async (request) => {
    if (!isCloudAuthSend(request.method, new URL(request.url).pathname)) return null;
    const verdict = await perIp.tryConsume(request);
    const refused = verdict.ok ? await everyone.tryConsumeKey('all') : verdict;
    if (refused.ok) return null;
    return new Response(
      JSON.stringify({ error: 'Too Many Requests', retryAfterSec: refused.retryAfterSec }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(refused.retryAfterSec),
        },
      }
    );
  };
}
