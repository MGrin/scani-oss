import { ProviderError } from '@scani/providers/core/errors';

// A use case wraps a per-account failure in its own summary and keeps the
// provider's error as `cause`. Only a ProviderError's message was written by a
// provider about the venue's answer; anything else may be internal text
// (SC-551), so it is never what the job's owner is shown.
export function providerErrorIn(err: unknown): ProviderError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof ProviderError) return current;
    current = current.cause;
  }
  return null;
}
