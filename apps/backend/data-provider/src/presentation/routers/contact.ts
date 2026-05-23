/**
 * Public contact-form endpoint.
 *
 * The landing page (example.com/contact) calls this with no bearer token.
 * A submission fans out into two emails:
 *   1. an ops notification to `SCANI_BRAND.supportAddress` — the message
 *      itself; this MUST send, so a failure surfaces as a 500 and the
 *      visitor is told to retry rather than silently losing their note.
 *   2. a best-effort receipt to the submitter so they have proof in
 *      their inbox; a transient SMTP failure here is logged, not fatal.
 *
 * Abuse defenses:
 *   1. zod input validation (real-looking email, capped lengths)
 *   2. per-IP rate limiter (5 submissions / hour) via the shared
 *      Redis-backed limiter, with the in-memory fallback in dev/tests
 *
 * No DB: the support inbox is the system of record, so this works on any
 * deployment without a CloudDb.
 */

import { LocalEmailService, renderContactReceivedEmail, SCANI_BRAND } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, getSharedRedis } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

const log = createComponentLogger('data-provider:contact');

// 5/hr/IP: comfortably above what a genuine visitor needs (one message,
// maybe a follow-up) but tight enough that the form can't be turned into
// an email relay. Shares the inflow Redis namespace so dev (in-memory
// fallback) and prod (Upstash) behave identically.
const contactSubmitLimiter = createOutflowLimiter({
  maxRequests: 5,
  windowMs: 3_600_000,
  redis: getSharedRedis(),
  namespace: 'inflow:contact-submit',
});

const TOPICS = ['support', 'sales', 'feedback', 'security', 'other'] as const;

const TOPIC_LABELS: Record<(typeof TOPICS)[number], string> = {
  support: 'Support',
  sales: 'Sales',
  feedback: 'Feedback',
  security: 'Security',
  other: 'General',
};

// The submitter's address can't be used as the SMTP `from` (it would fail
// SPF/DKIM), so the ops mail is sent from the no-reply identity and the
// real address is surfaced in the body for the team to reply to.
const OPS_NOTIFY_FROM = 'no-reply@example.com';

export const contactRouter = router({
  submit: publicProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/contact.submit',
        tags: ['contact'],
        summary: 'Submit the public contact form',
      },
    })
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        email: z.string().email().max(254),
        topic: z.enum(TOPICS).default('support'),
        message: z.string().trim().min(10).max(4000),
        referrer: z.string().max(200).optional(),
      })
    )
    .output(z.unknown())
    .mutation(async ({ input, ctx }): Promise<{ ok: true }> => {
      // Best-effort limiter key: when no IP is available (tests, direct
      // calls) all callers share one bucket.
      const limiterKey = ctx.clientIp ?? 'unknown';
      const budget = await contactSubmitLimiter.tryConsume(limiterKey);
      if (!budget.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many messages; retry in ${Math.ceil(budget.retryAfterMs / 1000)}s`,
        });
      }

      const name = input.name.trim();
      const email = input.email.trim().toLowerCase();
      const topicLabel = TOPIC_LABELS[input.topic];
      const emailService = Container.get(LocalEmailService);

      // The ops notification IS the delivery — if it fails the visitor's
      // message is lost, so this send must surface as an error.
      try {
        await emailService.send({
          from: OPS_NOTIFY_FROM,
          to: SCANI_BRAND.supportAddress,
          subject: `[${topicLabel}] Contact form — ${name}`,
          text: [
            `Topic:     ${topicLabel}`,
            `From:      ${name} <${email}>`,
            `Referrer:  ${input.referrer ?? '(none)'}`,
            ``,
            `Message:`,
            input.message.trim(),
            ``,
            `— Reply directly to ${email}.`,
          ].join('\n'),
        });
      } catch (err) {
        log.error(
          { error: err instanceof Error ? err.message : String(err), topic: input.topic },
          'Failed to deliver contact form submission'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: "We couldn't send your message right now — please try again shortly.",
        });
      }

      log.info({ topic: input.topic }, 'Contact form submission delivered');

      // User-facing receipt. Best-effort: the message already reached the
      // support inbox above, so an SMTP hiccup here must not 500 the form.
      try {
        await emailService.sendBranded({
          to: email,
          brand: SCANI_BRAND,
          content: renderContactReceivedEmail({ brand: SCANI_BRAND, name }),
        });
      } catch (err) {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Failed to send contact form confirmation email'
        );
      }

      return { ok: true };
    }),
});
