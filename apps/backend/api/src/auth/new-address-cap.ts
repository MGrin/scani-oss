/**
 * One hourly budget, shared by every caller, for sign-in codes and links sent
 * to an address that has no account yet (SC-1260).
 *
 * The per-IP limiter stops one machine; scripted signups rotate machines. A
 * cap on every send would lock existing users out on a busy day, so only
 * account-CREATING sends spend this budget — an address with an account is
 * never counted and never refused.
 *
 * Past the cap the caller gets Better-Auth's own success body and no mail is
 * sent. A 429 here would be an enumeration oracle: once the budget is spent,
 * "refused" would mean "no account" and "sent" would mean "has one".
 */

import { createInflowLimiter } from '@scani/rate-limiter';
import type { Redis } from 'ioredis';

const HOUR_MS = 60 * 60 * 1000;

const CREATING_SENDS: Record<string, unknown> = {
  '/api/auth/email-otp/send-verification-otp': { success: true },
  '/api/auth/sign-in/magic-link': { status: true },
};

export type NewAddressVerdict = { send: true } | { send: false; body: unknown };

function emailOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const email = (body as { email?: unknown }).email;
  return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null;
}

export function createNewAddressCap(opts: {
  redis: Redis | null;
  perHour?: number;
  hasAccount(email: string): Promise<boolean>;
}): (method: string, pathname: string, body: unknown) => Promise<NewAddressVerdict> {
  const limiter = createInflowLimiter(opts.redis, {
    windowMs: HOUR_MS,
    max: opts.perHour ?? 100,
    namespace: 'rl:new-address',
  });

  return async (method, pathname, body) => {
    if (method !== 'POST' || !(pathname in CREATING_SENDS)) return { send: true };
    const email = emailOf(body);
    if (!email || (await opts.hasAccount(email))) return { send: true };
    const budget = await limiter.tryConsumeKey('all');
    return budget.ok ? { send: true } : { send: false, body: CREATING_SENDS[pathname] };
  };
}
