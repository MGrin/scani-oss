import { LocalEmailService } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

// Outbound transactional email only — the backend's Better-Auth setup
// talks to this via cloud-client's EmailFacade when SCANI_CLOUD_URL is
// set. Both sides share @scani/email's EmailMessage shape, so the wire
// payload is just a pass-through to LocalEmailService.send.
const log = createComponentLogger('data-provider:email');

const sendInput = z.object({
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
});

export const emailRouter = router({
  send: bearerProcedure.input(sendInput).mutation(async ({ input }) => {
    try {
      await Container.get(LocalEmailService).send(input);
      return { ok: true as const };
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
