import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidateVaultQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { tokenDisplayName } from '@/lib/utils';
import { compareMembers, type MemberEntry } from '../lib/membership';

export function useVaultAttach(vaultId: string, attachedHoldingIds: ReadonlySet<string>) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const allocations = trpc.vaults.allocations.useQuery();
  const mutation = trpc.vaults.setAllocations.useMutation();
  const candidates: MemberEntry[] = useMemo(
    () =>
      (holdingsQuery.data?.holdings ?? [])
        .filter((h) => !attachedHoldingIds.has(h.id))
        .map((h) => ({
          id: h.id,
          kind: 'holding' as const,
          label: [h.token.symbol, h.label].filter(Boolean).join(' · '),
          sublabel: `${tokenDisplayName(t, h.token)} · ${h.account.name} · ${h.institution.name}`,
          account: h.account.name,
          accountId: h.account.id,
          available: allocations.data
            ? Math.floor(
                Math.max(
                  0,
                  100.00001 -
                    allocations.data
                      .filter((a) => a.holdingId === h.id && a.vaultId !== vaultId)
                      .reduce((sum, a) => sum + a.percentage, 0)
                ) * 100
              ) / 100
            : 0,
        }))
        .sort(compareMembers),
    [holdingsQuery.data, allocations.data, attachedHoldingIds, vaultId, t]
  );
  const add = async (entries: MemberEntry[], percentages: Record<string, number>) => {
    try {
      await mutation.mutateAsync({
        vaultId,
        entries: entries.map((entry) => ({
          holdingId: entry.id,
          percentage: percentages[entry.id] ?? 0,
        })),
      });
      await Promise.all([invalidateVaultQueries(utils), utils.vaults.allocations.invalidate()]);
      showSuccess(t('v3.vaults.detail.toast.shareUpdated'));
    } catch (error) {
      showError(error, t('v3.vaults.attach.attaching'));
      throw error;
    }
  };
  // The sheet shows what each share is worth and where the rest of a holding
  // already counts; both come from the queries this hook already holds.
  const values = useMemo(
    () => new Map((holdingsQuery.data?.holdings ?? []).map((h) => [h.id, h.value] as const)),
    [holdingsQuery.data]
  );
  return {
    candidates,
    values,
    allocations: allocations.data ?? [],
    pending: mutation.isPending,
    pendingIds: new Set(mutation.isPending ? candidates.map((e) => `${e.kind}:${e.id}`) : []),
    isLoading: holdingsQuery.isLoading || allocations.isLoading,
    add,
  };
}
