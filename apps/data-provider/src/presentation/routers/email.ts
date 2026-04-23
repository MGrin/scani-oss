import { createFastmailSender, type FastmailSender } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

/**
 * Email router — outbound transactional email only. No inbound, no list
 * management. Backend's Better-Auth setup talks to this via a thin
 * `CloudEmail` adapter whose `sendMail(...)` signature matches the
 * existing `FastmailSender` interface 1:1, so Better-Auth code doesn't
 * care whether the send happens here or in-process.
 */

const log = createComponentLogger('data-provider:email');

// Lazily so a missing FASTMAIL_API_TOKEN (OSS dev install wanting SMTP
// instead) doesn't crash boot. If neither Fastmail nor SMTP is wired up
// on the data-provider side we fall back to an error at send time.
let cached: { sender: FastmailSender | null; smtpUrl: string | undefined } | null = null;

function getSender(): { sender: FastmailSender | null; smtpUrl: string | undefined } {
  if (cached) return cached;
  const token = process.env.FASTMAIL_API_TOKEN;
  const smtpUrl = process.env.SMTP_URL;
  cached = {
    sender: token ? createFastmailSender(token) : null,
    smtpUrl,
  };
  if (!cached.sender && !cached.smtpUrl) {
    log.warn({}, 'Email router booted with neither FASTMAIL_API_TOKEN nor SMTP_URL');
  }
  return cached;
}

const sendInput = z.object({
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
});

export const emailRouter = router({
  send: bearerProcedure.input(sendInput).mutation(async ({ input }) => {
    const { sender, smtpUrl } = getSender();
    try {
      if (sender) {
        await sender.sendMail(input);
        return { transport: 'fastmail' as const };
      }
      if (smtpUrl) {
        // Dynamic import so OSS self-hosters that exclude nodemailer don't
        // pay the startup cost. The managed deployment never hits this
        // branch (FASTMAIL_API_TOKEN is set in production).
        const { createTransport } = await import('nodemailer');
        const transport = createTransport(smtpUrl);
        await transport.sendMail(input);
        return { transport: 'smtp' as const };
      }
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'No email transport configured on data-provider',
      });
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      log.error({ error: err instanceof Error ? err.message : String(err) }, 'Email send failed');
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }),
});
