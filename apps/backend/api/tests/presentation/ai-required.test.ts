import { describe, expect, test } from 'bun:test';
import { AIUnavailableError } from '@scani/providers/core/errors';
import { TRPCError } from '@trpc/server';
import { requireAI } from '../../src/presentation/ai-required';

describe('requireAI (SC-1397)', () => {
  test('an unavailable AI provider is a precondition the client is told about, not a 500', async () => {
    for (const state of ['missing', 'rejected', 'transient'] as const) {
      const refusal = await requireAI(async () => {
        throw new AIUnavailableError(state);
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(TRPCError);
      expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((refusal as Error).message).toMatch(/Statement files and manual entry still work/);
    }
  });

  test('any other failure is left as it is', async () => {
    const boom = new Error('database down');
    await expect(
      requireAI(async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  test('an available provider lets the request through', async () => {
    await expect(requireAI(async () => undefined)).resolves.toBeUndefined();
  });
});
