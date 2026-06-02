import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

// .output() exists for the generated OpenAPI spec's typed response, not for
// runtime validation — this is the foundation's typed vertical slice.
export const PingOutput = z.object({
  status: z.literal('ok'),
  service: z.string(),
});

export const systemRouter = router({
  ping: publicProcedure.output(PingOutput).query(() => ({
    status: 'ok' as const,
    service: 'api',
  })),
});
