import { HoldingRepository, TokenRepository } from '@scani/domain/repositories';
import { holdingPositionKey } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';

/**
 * The sentence for a create that repeats a position the account already holds
 * (SC-1527). Short and single-line on purpose: the screenshot review shows it
 * through `describeQueryError`, whose `rejectionReason` drops anything else.
 */
export function describeHeldDuplicates(symbols: string[]): string {
  return `This account already holds ${symbols.join(', ')} under the same name. Give the new row its own name to keep it as a separate pot, or change the existing holding's balance instead.`;
}

/**
 * Refuse, before anything is enqueued, the held-position collision the worker
 * would refuse after (SC-1527). A repeat WITHIN the payload is the form's own
 * blocker and is left to the worker, which still refuses it.
 *
 * The worker's `DuplicateHoldingTokenError` fails the whole job — every valid
 * row in the batch with it — and reaches the reader as a dead job in /jobs,
 * after the form has been left behind. Asked here, the same rule answers while
 * the rows are still on the form. The worker keeps its check: this one reads
 * before the job runs, and only the transaction can see the account as the
 * write finds it.
 */
export async function refuseHeldDuplicates(
  userId: string,
  accountId: string,
  creating: readonly { tokenId: string; label?: string }[]
): Promise<void> {
  if (creating.length === 0) return;
  const held = await Container.get(HoldingRepository).findUnsyncedByAccountAndTokens(
    accountId,
    [...new Set(creating.map((row) => row.tokenId))],
    userId
  );
  const taken = new Set(held.map((row) => holdingPositionKey(row.tokenId, row.label)));
  const colliding = [
    ...new Set(
      creating
        .filter((row) => taken.has(holdingPositionKey(row.tokenId, row.label)))
        .map((row) => row.tokenId)
    ),
  ];
  if (colliding.length === 0) return;
  const tokens = await Container.get(TokenRepository).findManyWithTypes(colliding);
  const symbols =
    tokens.length === colliding.length ? tokens.map((token) => token.symbol).sort() : [];
  throw new TRPCError({
    code: 'CONFLICT',
    message: describeHeldDuplicates(symbols.length > 0 ? symbols : ['one of these tokens']),
  });
}
