import { TRPCClientError } from '@trpc/client';

// Wraps tRPC errors so domain code pattern-matches on `code` without importing
// tRPC. `cause` preserves the original for Sentry root-cause visibility.
export class CloudError extends Error {
  readonly code: string;
  // biome-ignore lint/suspicious/noExplicitAny: cause is intentionally any
  override readonly cause: any;
  readonly retryable: boolean;

  // biome-ignore lint/suspicious/noExplicitAny: cause is intentionally any
  constructor(message: string, code: string, cause: any, retryable = false) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.cause = cause;
    this.retryable = retryable;
  }

  static wrap(err: unknown, fallback = 'INTERNAL_SERVER_ERROR'): CloudError {
    if (err instanceof CloudError) return err;
    if (err instanceof TRPCClientError) {
      const code = (err.data as { code?: string } | null | undefined)?.code ?? fallback;
      const retryable =
        code === 'TIMEOUT' || code === 'TOO_MANY_REQUESTS' || code === 'INTERNAL_SERVER_ERROR';
      return new CloudError(err.message, code, err, retryable);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new CloudError(message, fallback, err, true);
  }
}
