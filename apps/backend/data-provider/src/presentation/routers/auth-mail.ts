import { withDeadline } from '@scani/deadline';
import { LocalEmailService, SCANI_BRAND } from '@scani/email';
import { createOutflowLimiter, getSharedRedis } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { ProcessingGuard } from '../../usage/processing-guard';
import { bearerProcedure } from '../trpc';

const origin = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === value;
  }, 'A HTTPS origin is required');
const common = {
  to: z.string().email().max(254),
  appOrigin: origin,
  language: z.string().max(16).nullish(),
};
const input = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('otp'),
        code: z.string().regex(/^\d{6}$/),
        type: z.enum(['sign-in', 'email-verification', 'forget-password', 'change-email']),
      })
      .strict(),
    z
      .object({ ...common, kind: z.literal('magic-link'), url: z.string().url().max(4096) })
      .strict(),
    z
      .object({ ...common, kind: z.literal('verification'), url: z.string().url().max(4096) })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.kind === 'otp') return;
    const url = new URL(value.url);
    const expected =
      value.kind === 'magic-link' ? '/api/auth/magic-link/verify' : '/api/auth/verify-email';
    const callbacks = ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL'];
    let valid =
      url.protocol === 'https:' &&
      url.origin === value.appOrigin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === expected &&
      Boolean(url.searchParams.get('token'));
    for (const [key, param] of url.searchParams) {
      if (key === 'token') continue;
      if (!callbacks.includes(key)) {
        valid = false;
        continue;
      }
      try {
        const destination = new URL(param, value.appOrigin);
        if (
          ![value.appOrigin, url.origin].includes(destination.origin) ||
          destination.username ||
          destination.password
        )
          valid = false;
      } catch {
        valid = false;
      }
    }
    if (!valid)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Invalid self-hosted authentication link',
      });
  });

export const authMailProcedure = bearerProcedure.input(input).mutation(async ({ input, ctx }) => {
  const redis = getSharedRedis();
  const recipient = new Bun.CryptoHasher('sha256').update(input.to.toLowerCase()).digest('hex');
  const owner = ctx.auth.ownerUserId ?? ctx.auth.tenantId;
  const result = await Container.get(ProcessingGuard).run(
    redis,
    owner,
    'auth-mail',
    input,
    async (signal) => {
      const limiter = createOutflowLimiter({
        redis,
        namespace: 'inflow:auth-mail-recipient',
        maxRequests: 10,
        windowMs: 3_600_000,
      });
      if (
        !(
          await withDeadline(
            limiter.tryConsume(recipient),
            250,
            () =>
              new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Mail protection unavailable' })
          )
        ).ok
      )
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Recipient email limit reached',
        });
      signal.throwIfAborted();
      const brand = {
        ...SCANI_BRAND,
        from: '"Scani self-hosted" <welcome@scani.xyz>',
        appName: `Scani self-hosted (${new URL(input.appOrigin).hostname})`,
        appUrl: input.appOrigin,
      };
      const email = Container.get(LocalEmailService);
      if (input.kind === 'otp') await email.sendOtp({ ...input, brand }, signal);
      else if (input.kind === 'magic-link') await email.sendMagicLink({ ...input, brand }, signal);
      else await email.sendVerificationEmail({ ...input, brand }, signal);
      return { ok: true as const };
    }
  );
  return result.result;
});
