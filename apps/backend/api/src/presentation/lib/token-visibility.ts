import { TokenRepository } from '@scani/domain/repositories';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';

/**
 * Refuse a client-supplied token id the caller may not use: another user's
 * custom token (SC-1285). Every procedure that stores or converts through a
 * token id it did not read from the caller's own rows goes through here — a
 * holding, a base currency, a vault or payment currency, a series override.
 *
 * The refusal is `NOT_FOUND`, the same one an id that does not exist gets, so
 * it cannot be used to learn that somebody else's token exists.
 */
export async function assertTokensVisible(
  userId: string,
  tokenIds: ReadonlyArray<string | null | undefined>
): Promise<void> {
  const wanted = Array.from(new Set(tokenIds.filter((id): id is string => !!id)));
  if (wanted.length === 0) return;
  const visible = await Container.get(TokenRepository).findVisibleIds(wanted, userId);
  if (wanted.some((id) => !visible.has(id))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Token not found' });
  }
}
