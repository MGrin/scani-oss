import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { candidatesFor, compareMembers, type MemberEntry } from '../lib/membership';

/**
 * A group's membership, as two lists and two verbs.
 *
 * Membership lives on the *entities*, not on the group — a holding carries its
 * groups and so does an account — so both sides are derived here from the two
 * queries the rest of v3 already has cached rather than from a third endpoint.
 * That is also why one add is one `bulkAssignGroups` call with a single id: the
 * backend's add and remove paths must operate on disjoint lists (calling both
 * on the same list cancels out), which the wizard handled by diffing two sets
 * on Save. With immediate application there is no diff to compute — the row the
 * reader touched *is* the list.
 *
 * `pendingIds` is per-row rather than one `isPending` for the surface: two taps
 * in quick succession are the normal case here, and greying the whole list on
 * the first would make the second impossible.
 */
export function useGroupMembership(groupId: string) {
  const utils = trpc.useUtils();
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const accountsQuery = trpc.accounts.getByUserIdWithSummary.useQuery();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const settle = (key: string) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  const assignHoldings = trpc.holdings.bulkAssignGroups.useMutation();
  const assignAccounts = trpc.accounts.bulkAssignGroups.useMutation();

  const all: MemberEntry[] = useMemo(() => {
    const holdings = (holdingsQuery.data?.holdings ?? []).map((holding) => ({
      id: holding.id,
      kind: 'holding' as const,
      label: holding.token.symbol,
      sublabel: `${holding.token.name} · ${holding.institution.name}`,
    }));
    // An account is never a member in its own right — `account_groups` is a
    // cache the backend rebuilds from `holding_groups`, and the rule is *every*
    // visible holding in the account. So the row has to say what it stands for,
    // or a reader sees an account they never added appear the moment its last
    // holding goes in, and reads that as a bug.
    const accounts = (accountsQuery.data ?? []).map((account) => {
      const count = account.summary.holdingsCount;
      const noun = count === 1 ? 'holding' : 'holdings';
      return {
        id: account.id,
        kind: 'account' as const,
        label: account.name,
        sublabel: `All ${count} ${noun}`,
      };
    });
    return [...holdings, ...accounts];
  }, [holdingsQuery.data, accountsQuery.data]);

  const members: MemberEntry[] = useMemo(() => {
    const holdingIds = new Set(
      (holdingsQuery.data?.holdings ?? [])
        .filter((holding) => holding.groups.some((group) => group.id === groupId))
        .map((holding) => holding.id)
    );
    const accountIds = new Set(
      (accountsQuery.data ?? [])
        .filter((account) => account.groups.some((group) => group.id === groupId))
        .map((account) => account.id)
    );
    return all
      .filter((entry) =>
        entry.kind === 'holding' ? holdingIds.has(entry.id) : accountIds.has(entry.id)
      )
      .sort(compareMembers);
  }, [all, holdingsQuery.data, accountsQuery.data, groupId]);

  const candidates = useMemo(() => candidatesFor(all, members), [all, members]);

  const apply = async (entry: MemberEntry, direction: 'add' | 'remove') => {
    const key = `${entry.kind}:${entry.id}`;
    setPendingIds((prev) => new Set(prev).add(key));
    const groupIds = { addedGroupIds: [] as string[], removedGroupIds: [] as string[] };
    if (direction === 'add') groupIds.addedGroupIds = [groupId];
    else groupIds.removedGroupIds = [groupId];

    try {
      if (entry.kind === 'holding') {
        await assignHoldings.mutateAsync({ holdingIds: [entry.id], ...groupIds });
      } else {
        await assignAccounts.mutateAsync({ accountIds: [entry.id], ...groupIds });
      }
      // The two lists this surface reads are the ones that changed, so they are
      // awaited; the portfolio-wide refetch is a dozen queries nobody on this
      // screen is waiting for and runs behind it.
      await Promise.all([
        utils.holdings.getWithDetails.invalidate(),
        utils.accounts.getByUserIdWithSummary.invalidate(),
        utils.groups.getAllWithCounts.invalidate(),
      ]);
      showSuccess(
        direction === 'add'
          ? `${entry.label} added to the group`
          : `${entry.label} removed from the group`
      );
      void invalidatePortfolioQueries(utils);
    } catch (error) {
      showError(error, direction === 'add' ? 'Adding to the group' : 'Removing from the group');
    } finally {
      settle(key);
    }
  };

  return {
    members,
    candidates,
    pendingIds,
    isLoading: holdingsQuery.isLoading || accountsQuery.isLoading,
    add: (entry: MemberEntry) => void apply(entry, 'add'),
    remove: (entry: MemberEntry) => void apply(entry, 'remove'),
  };
}
