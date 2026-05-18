/**
 * Public beta-preview waitlist endpoint.
 *
 * The landing page (scani.xyz) calls this with no bearer token; signups
 * are persisted to `waitlist_signups` and grandfather the email into
 * the 1-year-free promise that triggers when subscriptions launch
 * (see `apps/frontend/landing/src/components/sections/BetaPromise.tsx`).
 *
 * Three abuse-defense layers:
 *   1. zod input validation (real-looking email, capped lengths)
 *   2. per-IP rate limiter (3 attempts / hour) via the same Redis-
 *      backed `OutflowRateLimiter` `chains.hasActivity` uses
 *   3. unique constraint on `email` makes duplicate signups idempotent
 *      no-ops rather than data dupes
 *
 * Cloud DB is required: this is a Tier 2/3 surface only. OSS Tier 1
 * deploys don't host the landing page anyway, so PRECONDITION_FAILED
 * is the correct response when the DB isn't configured.
 */

import { waitlistSignups } from '@scani/db';
import { LocalEmailService, renderWaitlistJoinEmail, SCANI_BRAND } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, getSharedRedis } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import type { CloudDb } from '../../db/connection';
import { publicProcedure, router } from '../trpc';

const log = createComponentLogger('data-provider:waitlist');

let cloudDbRef: CloudDb | null = null;
export function installWaitlistCloudDb(db: CloudDb | null): void {
  cloudDbRef = db;
}

function requireDb(): CloudDb {
  if (!cloudDbRef) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Waitlist is not configured on this deployment',
    });
  }
  return cloudDbRef;
}

// 3/hr/IP is generous for genuine landing visitors but tight enough that
// a botnet can't enumerate every email on the planet through this surface.
// Lives in the same Redis namespace as other inflow limiters so OSS dev
// (with the in-memory fallback) and prod (Upstash-backed) behave the same.
const waitlistJoinLimiter = createOutflowLimiter({
  maxRequests: 3,
  windowMs: 3_600_000,
  redis: getSharedRedis(),
  namespace: 'inflow:waitlist-join',
});

// Hash the IP with a per-deploy salt so two replicas behind the same
// LB still bucket the same caller together, but a leaked DB row never
// reveals the original address.
async function hashIp(ip: string): Promise<string> {
  const salt = process.env.WAITLIST_IP_SALT ?? 'scani-waitlist';
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(digest).toString('hex');
}

const OPS_NOTIFY_TO = process.env.WAITLIST_OPS_EMAIL ?? null;
const OPS_NOTIFY_FROM = process.env.WAITLIST_OPS_FROM ?? 'no-reply@scani.xyz';

async function notifyOps(args: {
  email: string;
  source: string;
  referrer: string | null;
  isDuplicate: boolean;
}): Promise<void> {
  if (!OPS_NOTIFY_TO || args.isDuplicate) return;
  try {
    await Container.get(LocalEmailService).send({
      from: OPS_NOTIFY_FROM,
      to: OPS_NOTIFY_TO,
      subject: `New beta waitlist signup: ${args.email}`,
      text: [
        `Email: ${args.email}`,
        `Source: ${args.source}`,
        `Referrer: ${args.referrer ?? '(none)'}`,
      ].join('\n'),
    });
  } catch (err) {
    // Notification is best-effort; the signup itself is durable in
    // Postgres so a transient SMTP outage shouldn't 500 the user.
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to send waitlist ops notification'
    );
  }
}

// Sends the user-facing confirmation. Reuses the auth-email layout from
// `@scani/email/templates` so visual language matches sign-in mail. Only
// fires on the first signup — duplicate submissions skip the send so we
// don't spam someone who taps the form twice. Best-effort: a transient
// SMTP failure here is logged and swallowed; the signup itself is
// already durable in Postgres.
async function sendUserConfirmation(args: { email: string; isDuplicate: boolean }): Promise<void> {
  if (args.isDuplicate) return;
  try {
    await Container.get(LocalEmailService).sendTracked({
      to: args.email,
      template: 'waitlist-join',
      app: 'landing',
      brand: SCANI_BRAND,
      content: renderWaitlistJoinEmail({ brand: SCANI_BRAND, email: args.email }),
    });
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to send waitlist confirmation email'
    );
  }
}

export const waitlistRouter = router({
  join: publicProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/waitlist.join',
        tags: ['waitlist'],
        summary: 'Join the beta-preview waitlist',
      },
    })
    .input(
      z.object({
        email: z.string().email().max(254),
        source: z.string().min(1).max(40).default('landing'),
        referrer: z.string().max(200).optional(),
      })
    )
    .output(z.unknown())
    .mutation(async ({ input, ctx }): Promise<{ ok: true; alreadyJoined: boolean }> => {
      const ip = ctx.clientIp;
      // The limiter key is best-effort: when no IP is available (tests,
      // direct calls) we fall back to a single shared bucket. The unique
      // email constraint downstream still prevents data abuse.
      const limiterKey = ip ?? 'unknown';
      const budget = await waitlistJoinLimiter.tryConsume(limiterKey);
      if (!budget.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many signups; retry in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
        });
      }

      const email = input.email.trim().toLowerCase();
      const ipHash = ip ? await hashIp(ip) : null;
      const db = requireDb();

      // Idempotent insert: ON CONFLICT (email) DO NOTHING. If the row
      // already existed we read it back so the UI can show the original
      // signup date.
      const inserted = await db
        .insert(waitlistSignups)
        .values({
          email,
          source: input.source,
          referrer: input.referrer ?? null,
          ipHash,
        })
        .onConflictDoNothing({ target: waitlistSignups.email })
        .returning({ id: waitlistSignups.id });

      const isDuplicate = inserted.length === 0;
      if (isDuplicate) {
        // Still confirm the row exists so we can surface a clean
        // "already on the list" UX instead of leaking the conflict.
        const existing = await db
          .select({ id: waitlistSignups.id })
          .from(waitlistSignups)
          .where(eq(waitlistSignups.email, email))
          .limit(1);
        if (existing.length === 0) {
          // Belt-and-braces: insert silently failed AND row vanished.
          // Treat as a genuine server error rather than a happy path.
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Waitlist insert failed for unknown reason',
          });
        }
      } else {
        log.info({ source: input.source }, 'Beta waitlist signup recorded');
      }

      // Fan out two best-effort notifications in parallel: an internal
      // ops alert (so the team sees signups in real-time) and a user-
      // facing confirmation (so they have proof of signup in their
      // inbox). Both swallow their own errors; the signup is already
      // durable, so SMTP hiccups must not 500 the public endpoint.
      await Promise.all([
        notifyOps({
          email,
          source: input.source,
          referrer: input.referrer ?? null,
          isDuplicate,
        }),
        sendUserConfirmation({ email, isDuplicate }),
      ]);

      return { ok: true, alreadyJoined: isDuplicate };
    }),
});
