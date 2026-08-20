import z from 'zod';
import { Decimal, isValidDecimalString } from '../decimal';
import { CreateAccountDto } from './account';
import type { Holding } from './holding';
import { CreateInstitutionDto } from './institution';

/**
 * A pot name is a label on a row in a list, not a description. Long enough for
 * "Wedding gift" and "Deposit 12 months", short enough that the holdings list
 * still reads as a list.
 */
export const HOLDING_LABEL_MAX_LENGTH = 40;

/**
 * What identifies a hand-entered position inside one account.
 *
 * The token alone is not it. A Tinkoff current account, a savings pot and two
 * deposits are four RUB positions on one bank screen, and production has held
 * them since 2026-05-17 — the user re-confirmed all four independently seven
 * weeks later, one of them downwards. The token plus the name the user gave
 * the pot is what tells those four apart from one RUB typed four times.
 *
 * An absent name normalises to the empty string rather than to "unique", so
 * the accident the SC-303 guard was built for is still an accident: two
 * unnamed rows for one token collide exactly as they did before. Naming one is
 * the act that says they are different things, and nobody types "Savings" by
 * mistake.
 *
 * Lives in shared because the review screen must refuse exactly what the
 * server refuses. Two implementations of this rule drift, and the direction
 * they drift in is a form that submits and then fails the job.
 */
export function holdingPositionKey(tokenId: string, label?: string | null): string {
  return `${tokenId}\u0000${(label ?? '').trim().toLowerCase()}`;
}

/**
 * Tokens this payload puts on more than one row — the rows that have to say
 * WHICH position they are before they can be sent.
 *
 * Deliberately blind to the names. This decides whether to ASK, and a question
 * that withdraws itself the moment the first answer is typed takes the other
 * rows' fields away mid-sentence. `collidingHoldingTokens` is the half that
 * decides whether the answer is good enough.
 *
 * `held` are positions the account already has that this payload is updating
 * rather than creating: a create beside an update of the same token is two
 * rows on one token just as much as two creates are.
 */
export function contestedHoldingTokens(
  creating: readonly { tokenId: string }[],
  held: readonly { tokenId: string }[] = []
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of creating) counts.set(row.tokenId, (counts.get(row.tokenId) ?? 0) + 1);
  const heldTokens = new Set(held.map((row) => row.tokenId));
  return new Set(
    [...counts.entries()]
      .filter(([tokenId, count]) => count > 1 || heldTokens.has(tokenId))
      .map(([tokenId]) => tokenId)
  );
}

/**
 * Tokens still on two rows under the SAME name — the unresolved half, and the
 * only one that refuses anything.
 *
 * Two unnamed rows collide, which is the whole of the SC-303 protection: a
 * user who typed RUB twice is stopped exactly as before. Two rows given the
 * same name collide too, because copying one name into both expresses nothing.
 * Four differently-named pots do not collide, which is the Tinkoff shape this
 * exists for.
 *
 * `held` are the account's existing unsynced rows for these tokens. They are
 * matched on the same key, so production's four unnamed RUB rows do not block
 * a fifth NAMED one — requiring the existing rows to be renamed first would
 * trap the one account this was written for.
 */
export function collidingHoldingTokens(
  creating: readonly { tokenId: string; label?: string | null }[],
  held: readonly { tokenId: string; label?: string | null }[] = []
): Set<string> {
  const taken = new Set(held.map((row) => holdingPositionKey(row.tokenId, row.label)));
  const seen = new Set<string>();
  const colliding = new Set<string>();
  for (const row of creating) {
    const key = holdingPositionKey(row.tokenId, row.label);
    if (seen.has(key) || taken.has(key)) colliding.add(row.tokenId);
    seen.add(key);
  }
  return colliding;
}

export const CreateHoldingsWithDependenciesDto = z.object({
  institution: CreateInstitutionDto.optional(),

  accountId: z.string().uuid().optional(),
  account: CreateAccountDto.optional(),

  holdings: z
    .array(
      z.object({
        tokenId: z.string().uuid(),
        balance: z.string().refine(
          (val) => {
            if (!isValidDecimalString(val)) return false;
            return new Decimal(val).greaterThanOrEqualTo(0);
          },
          {
            message: 'Balance must be a valid decimal number string that is non-negative',
          }
        ),
        // What the user calls this pot, when one account holds several rows
        // for one token. Optional because the ordinary account holds one
        // (SC-330). Trimmed here rather than at the call sites so the
        // duplicate key and the stored value agree on what " Savings " is.
        label: z.string().trim().max(HOLDING_LABEL_MAX_LENGTH).optional(),
      })
    )
    .min(1, 'At least one holding is required'),
});

export type CreateHoldingsWithDependenciesInput = z.infer<typeof CreateHoldingsWithDependenciesDto>;

export type CreateHoldingsWithDependenciesResponseDto = {
  institutionId: string;
  accountId: string;
  holdings: Holding[];
  createdInstitution: boolean;
  createdAccount: boolean;
};

export type CreateHoldingsBatchResponseDto = CreateHoldingsWithDependenciesResponseDto & {
  updatedHoldingIds: string[];
};
