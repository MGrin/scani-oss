import { describe, expect, spyOn, test } from 'bun:test';
import * as sentry from '@scani/logging/sentry';
import { z } from 'zod';
import { strictInput } from '../../src/presentation/lib/strict-input';
import { publicProcedure, router } from '../../src/presentation/trpc';

/**
 * SC-1492: the unknown-parameter refusal reached Sentry as the TRPCError
 * itself, titled `[`. This drives the SHIPPED builder so the wiring, not only
 * the helper, is what is asserted.
 */

const probe = router({
  sc1492Strict: publicProcedure
    .input(strictInput(z.object({ limit: z.number() })))
    .query(() => 'ok'),
});

const caller = probe.createCaller({
  requestId: 'test-request',
  startTime: Date.now(),
  requestCache: new Map<string, unknown>(),
  headers: null,
  sessionRevokeLimiter: null,
  userId: null,
  email: null,
  isAuthenticated: false,
  dbUser: null,
} as unknown as Parameters<typeof probe.createCaller>[0]);

describe('an unknown-parameter refusal is captured under a readable title', () => {
  test('the captured error names the procedure and the key, with the refusal as its cause', async () => {
    const captured = spyOn(sentry, 'captureException');
    try {
      await expect(
        caller.sc1492Strict({ limit: 1, offset: 5 } as unknown as { limit: number })
      ).rejects.toThrow();
      expect(captured).toHaveBeenCalledTimes(1);
      const [error, tags] = captured.mock.calls[0] as [Error & { cause?: unknown }, unknown];
      expect(error.name).toBe('TRPCInputError');
      expect(error.message).toBe("sc1492Strict: (input) — Unrecognized key(s) in object: 'offset'");
      expect((error.cause as { code?: string }).code).toBe('BAD_REQUEST');
      expect(tags).toMatchObject({ route: 'sc1492Strict', unrecognizedKeys: 'offset' });
    } finally {
      captured.mockRestore();
    }
  });
});
