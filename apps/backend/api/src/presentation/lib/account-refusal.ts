import {
  AccountClassChange,
  UnknownWrapper,
  WrapperOnLiabilityAccount,
} from '@scani/domain/services';
import { TRPCError } from '@trpc/server';

/** SC-1645: an account refusal reaches the user as its own sentence, not a 500. */
export function rethrowAccountRefusal(error: unknown): never {
  if (
    error instanceof WrapperOnLiabilityAccount ||
    error instanceof UnknownWrapper ||
    error instanceof AccountClassChange
  ) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}
