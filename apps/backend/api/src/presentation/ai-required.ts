import { AIUnavailableError } from '@scani/providers/core/errors';
import { TRPCError } from '@trpc/server';

/**
 * Runs an AI availability check and turns "unavailable" into a refusal the
 * client can show. Unconverted, it would reach the caller as a 500 and Sentry
 * as a server fault, though it is a stated product mode.
 */
export async function requireAI(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (!(error instanceof AIUnavailableError)) throw error;
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'AI processing is unavailable, so this file cannot be read automatically. Statement files and manual entry still work.',
      cause: error,
    });
  }
}
