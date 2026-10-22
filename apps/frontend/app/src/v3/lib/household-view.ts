import type { RouterOutputs } from '@/lib/trpc';

export type HouseholdAccount = RouterOutputs['household']['view']['accounts'][number];
export type HouseholdMember = RouterOutputs['household']['mine']['members'][number];

/**
 * Each member with how many accounts they share and what those are worth.
 * A member who shares nothing still appears, at zero: being in the household
 * and sharing nothing is a fact the page should show (SC-1712).
 */
export function memberShares<M extends { userId: string; role: string }>(
  members: readonly M[],
  accounts: readonly Pick<HouseholdAccount, 'ownerId' | 'value'>[]
): Array<M & { count: number; value: number }> {
  return members
    .map((member) => {
      const own = accounts.filter((account) => account.ownerId === member.userId);
      return {
        ...member,
        count: own.length,
        value: own.reduce((sum, account) => sum + Number(account.value), 0),
      };
    })
    .sort((a, b) => Number(b.role === 'admin') - Number(a.role === 'admin') || b.value - a.value);
}
