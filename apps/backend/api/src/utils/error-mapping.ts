/**
 * Map an arbitrary thrown error into a typed `TRPCError`.
 *
 * Centralised because every router that talks to an upstream provider
 * (exchange integrations, wallet RPCs, file storage) needs the same
 * status-code → tRPC-code translation. Before extraction the logic
 * lived inline in `integrations.ts` and got copy-pasted into `wallet.ts`
 * and `file-import.ts` with drift. The shared helper is now the single
 * source of truth — callers pass a `fallbackCode` / `fallbackMessage`
 * for the "nothing else matched" case.
 */

import { ExpiredCredentialsError } from '@scani/domain/services';
import { TRPCError } from '@trpc/server';

export type TRPCErrorCode = ConstructorParameters<typeof TRPCError>[0]['code'];

export interface ToTRPCErrorContext {
  /** Final fallback when no specific branch matches. */
  fallbackCode: TRPCErrorCode;
  /** Human-readable message for the fallback case. */
  fallbackMessage: string;
}

/**
 * Already-a-TRPCError → passthrough.
 * ExpiredCredentialsError → UNAUTHORIZED (reconnect prompt).
 * Any 4xx/5xx upstream, timeouts, connection errors → specific codes.
 * Everything else → caller-provided fallback.
 */
export function toTRPCError(error: unknown, context: ToTRPCErrorContext): TRPCError {
  if (error instanceof TRPCError) return error;

  if (error instanceof ExpiredCredentialsError) {
    return new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Integration credentials have expired — please reconnect',
      cause: error,
    });
  }

  const err = error as Error & { code?: string | number; status?: number };
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const codeStr = typeof err?.code === 'string' ? err.code : undefined;
  const msg = err?.message?.toLowerCase() ?? '';

  if (status === 401 || status === 403 || msg.includes('unauthorized')) {
    return new TRPCError({
      code: 'UNAUTHORIZED',
      message: context.fallbackMessage,
      cause: error,
    });
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    return new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Upstream provider rate limit hit — try again shortly',
      cause: error,
    });
  }
  if (
    codeStr === 'ETIMEDOUT' ||
    codeStr === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  ) {
    return new TRPCError({
      code: 'TIMEOUT',
      message: 'Upstream provider timed out',
      cause: error,
    });
  }
  if (
    (typeof status === 'number' && status >= 500) ||
    codeStr === 'ECONNRESET' ||
    codeStr === 'ECONNREFUSED' ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused')
  ) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Upstream provider unavailable',
      cause: error,
    });
  }

  return new TRPCError({
    code: context.fallbackCode,
    message: context.fallbackMessage,
    cause: error,
  });
}
