import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidateVaultQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { compareMembers, type MemberEntry } from '../lib/membership';

/**
 * The holdings a vault could still claim, and attaching one in a single tap.
 *
 * The share is worked out rather than asked for. v2's dialog made attaching a
 * two-part act — pick a holding, then type a percentage — and printed how much
 * of it other vaults had already taken so the reader could do the subtraction
 * themselves. Here the fetch that produced that sentence produces the number
 * instead: attach at whatever is left, clamped to 100, and if a holding is
 * fully spoken for the row says so and does not pretend to be available.
 *
 * The share stays editable on the member row afterwards, which is where a
 * percentage belongs — beside the figure it is a share *of*.
 */
export function useVaultAttach(vaultId: string, attachedHoldingIds: ReadonlySet<string>) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const attach = trpc.vaults.attachHolding.useMutation();

  const candidates: MemberEntry[] = useMemo(
    () =>
      (holdingsQuery.data?.holdings ?? [])
        .filter((holding) => !attachedHoldingIds.has(holding.id))
        .map((holding) => ({
          id: holding.id,
          kind: 'holding' as const,
          label: holding.token.symbol,
          sublabel: `${holding.token.name} · ${holding.institution.name}`,
        }))
        .sort(compareMembers),
    [holdingsQuery.data, attachedHoldingIds]
  );

  const add = async (entry: MemberEntry) => {
    const key = `${entry.kind}:${entry.id}`;
    setPendingIds((prev) => new Set(prev).add(key));
    try {
      // What other vaults have already claimed of this holding. Fetched at the
      // moment of attaching rather than for every candidate up front: this is
      // one request for the row that was tapped, against one per row in a list
      // that is mostly never touched.
      const elsewhere = await utils.vaults.getByHoldingId.fetch({ holdingId: entry.id });
      const claimed = elsewhere
        .filter((vault) => vault.id !== vaultId)
        .reduce((sum, vault) => sum + (vault.percentage ?? 0), 0);
      const available = Math.max(0, Math.min(100, 100 - claimed));

      if (available === 0) {
        showError(
          new Error(t('v3.vaults.attach.fullyClaimed', { label: entry.label })),
          t('v3.vaults.attach.attaching')
        );
        return;
      }

      await attach.mutateAsync({ vaultId, holdingId: entry.id, percentage: available });
      await invalidateVaultQueries(utils);
      showSuccess(
        available === 100
          ? t('v3.vaults.attach.attachedWhole', { label: entry.label })
          : t('v3.vaults.attach.attachedPartial', { label: entry.label, available })
      );
    } catch (error) {
      showError(error, t('v3.vaults.attach.attaching'));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return {
    candidates,
    pendingIds,
    isLoading: holdingsQuery.isLoading,
    add: (entry: MemberEntry) => void add(entry),
  };
}
