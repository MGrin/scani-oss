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
import { ProviderError } from '@scani/providers/core/errors';
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

/**
 * A failed credential check, told apart from a credential that failed
 * (SC-445).
 *
 * `validateKeys` is the connect form's only answer, and every code below
 * becomes a different sentence on it. `BAD_REQUEST` is the one that says
 * "these details were rejected" — the reader's next move is to go back to the
 * venue and issue new keys — so it is reserved for a service that recognised
 * the request and refused it, which is what a provider signals by returning
 * `valid: false` or throwing `auth-failed`.
 *
 * Everything else is us failing to reach a verdict. Saying "rejected" there
 * sends someone to regenerate a credential that was never wrong, and on a
 * venue that counts failed attempts — IBKR's 1025 lockout, SC-279 — each
 * regeneration-and-retry is what keeps the lockout alive.
 *
 * `unrecoverable` and `not-supported` stay on `BAD_REQUEST` with the
 * provider's own words: both mean the request will not succeed as posed, and
 * the operand a user can act on (a wrong query id, an unsupported account
 * type) is in that message.
 */
export function toCredentialCheckError(error: unknown, institutionName: string): TRPCError {
  if (error instanceof TRPCError) return error;

  if (error instanceof ProviderError) {
    const detail = `${institutionName}: ${error.message}`;
    switch (error.kind) {
      case 'auth-failed':
      case 'unrecoverable':
      case 'not-supported':
        return new TRPCError({ code: 'BAD_REQUEST', message: detail, cause: error });
      case 'rate-limited':
        return new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `${institutionName} asked us to slow down — try again shortly`,
          cause: error,
        });
      case 'retryable':
        return new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Couldn't reach ${institutionName} to check these credentials`,
          cause: error,
        });
    }
  }

  const err = error as Error & { code?: string | number };
  const codeStr = typeof err?.code === 'string' ? err.code : undefined;
  const msg = err?.message?.toLowerCase() ?? '';
  if (
    codeStr === 'ETIMEDOUT' ||
    codeStr === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  ) {
    return new TRPCError({
      code: 'TIMEOUT',
      message: `${institutionName} took too long to answer`,
      cause: error,
    });
  }

  // An unclassified throw is not evidence about the credential. It used to
  // fall through to BAD_REQUEST, which made every unhandled failure read as
  // a rejection.
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `Couldn't reach ${institutionName} to check these credentials`,
    cause: error,
  });
}
