import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

// Typed output so the generated OpenAPI spec (and the Kotlin client) get a
// concrete response schema. This is the foundation's typed vertical slice.
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
