import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { Progress } from '@scani/ui/ui/progress';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { CircleMinus, Plus, Trash2, Vault } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { invalidateVaultQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import {
  optimisticDetachVaultHolding,
  optimisticRemoveVaults,
  optimisticSetVaultHoldingPercentage,
} from '@/v3/hooks/optimisticUpdates';
import { BackLink } from '../components/BackLink';
import { EditAction } from '../components/form/FormSheet';
import { VaultAttachSheet } from '../components/membership/VaultAttachSheet';
import { EditVaultShareAction } from '../components/vaults/EditVaultShareAction';
import { EditVaultSheet } from '../components/vaults/EditVaultSheet';
import { RemoveFromVaultAction } from '../components/vaults/RemoveFromVaultAction';
import { useVaultAttach } from '../hooks/useVaultAttach';
import { V3_ROUTES, vaultDetailPath } from '../lib/routes';
import {
  attributedValue,
  compareVaultHoldings,
  type VaultHoldingRow as VaultHoldingRowData,
  vaultIsMet,
  vaultProgress,
  vaultRemaining,
} from '../lib/vaults';

/**
 * One vault: how far along it is, and which holdings count toward it.
 *
 * A page rather than a peek because the member list is *editable* — every row
 * carries a percentage the user can change and a detach action — and an
 * editable list inside a sheet resting at half the viewport is two dismiss
 * gestures deep from the thing you came to change.
 *
 * SC-70 removed the three v2 dialogs this page used to stack on itself
 * (`VaultFormDialog` to edit, `AttachHoldingDialog` to attach, `ConfirmDialog`
 * to delete). Two reasons, and the second is the one that matters. The first:
 * all three are v2 components laid out for a desktop dialog, and at 390px a
 * dialog's primary action could leave the screen entirely — see the note in
 * `v3-tokens.css`. The second: a vault and a group are the same problem, and
 * they now have the same surface. Everything about editing one happens on the
 * record's own page, in place, with no overlay in the flow at all.
 *
 * The three membership mutations keep v2's optimistic pattern verbatim
 * (`onMutate` patch, `ctx.restore()` on error, `invalidateVaultQueries` on
 * settle). It is right, and a vault's numbers are server-computed, so the
 * invalidate is not optional.
 */
export function VaultDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const vaultQuery = trpc.vaults.getById.useQuery({ id }, { enabled: Boolean(id) });
  useDocumentTitle(vaultQuery.data?.name ?? t('v3.vaults.page.title'));

  const [editingDetails, setEditingDetails] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const removeMany = trpc.vaults.setAllocations.useMutation({
    onSuccess: async () => {
      setConfirmingRemove(false);
      await Promise.all([invalidateVaultQueries(utils), utils.vaults.allocations.invalidate()]);
    },
    onError: (error) => showError(error, t('v3.vaults.detail.toast.removingHolding')),
  });
  const [attaching, setAttaching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const attachedIds = useMemo(
    () => new Set((vaultQuery.data?.holdings ?? []).map((holding) => holding.holdingId)),
    [vaultQuery.data]
  );
  const attach = useVaultAttach(id, attachedIds);
  const baseCurrencyQuery = trpc.users.getBaseCurrency.useQuery();
  const vaultsQuery = trpc.vaults.getAll.useQuery();
  const vaultNames = useMemo(
    () => new Map((vaultsQuery.data ?? []).map((v) => [v.id, v.name] as const)),
    [vaultsQuery.data]
  );

  const deleteVault = trpc.vaults.delete.useMutation({
    onMutate: ({ id: vaultId }) => optimisticRemoveVaults(utils, [vaultId]),
    onSuccess: () => {
      showSuccess(t('v3.vaults.detail.toast.deleted'));
      navigate(V3_ROUTES.vaults, { replace: true });
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.vaults.detail.toast.deleting'));
    },
    // `'all'`, so the destination list refetches even though it is not mounted
    // yet at settle time.
    onSettled: () => void invalidateVaultQueries(utils, { refetchType: 'all' }),
  });

  const detach = trpc.vaults.detachHolding.useMutation({
    onMutate: ({ vaultId, holdingId }) => optimisticDetachVaultHolding(utils, vaultId, holdingId),
    onSuccess: () => showSuccess(t('v3.vaults.detail.toast.holdingRemoved')),
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.vaults.detail.toast.removingHolding'));
    },
    onSettled: () => void invalidateVaultQueries(utils),
  });

  const setPercentage = trpc.vaults.updateHoldingPercentage.useMutation({
    onMutate: ({ vaultId, holdingId, percentage }) =>
      optimisticSetVaultHoldingPercentage(utils, vaultId, holdingId, percentage),
    onSuccess: () => showSuccess(t('v3.vaults.detail.toast.shareUpdated')),
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.vaults.detail.toast.updatingShare'));
    },
    onSettled: () => void invalidateVaultQueries(utils),
  });

  if (!id) return null;

  if (vaultQuery.isLoading) {
    return (
      <PageLayout measure="wide">
        <BackLink to={V3_ROUTES.vaults} label={t('v3.vaults.detail.backToVaults')} />
        <Skeleton className="h-40 w-full" aria-hidden="true" />
      </PageLayout>
    );
  }

  const vault = vaultQuery.data;
  if (!vault) {
    return (
      <PageLayout measure="wide">
        <BackLink to={V3_ROUTES.vaults} label={t('v3.vaults.detail.backToVaults')} />
        <p className="text-body text-muted-foreground">{t('v3.vaults.detail.notFound')}</p>
      </PageLayout>
    );
  }

  const progress = vaultProgress(vault);
  const holdings = [...vault.holdings].sort(compareVaultHoldings);

  return (
    <PageLayout measure="wide">
      <BackLink to={V3_ROUTES.vaults} label={t('v3.vaults.detail.backToVaults')} />

      {/* The title sits inside the summary card, as on a group's page (SC-1433). */}
      <Block className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-full"
            style={{ backgroundColor: vault.color }}
          />
          <h1 className="min-w-0 truncate text-title">{vault.name}</h1>
        </div>
        <StatTile
          emphasis="hero"
          label={t('v3.vaults.detail.saved')}
          value={<Numeric value={vault.currentAmount} currency={vault.currencySymbol} />}
        />
        <Progress value={progress} className="h-2" />
        <p className="text-caption text-muted-foreground">
          {vaultIsMet(vault) ? (
            t('v3.vaults.detail.targetReached', { percent: progress.toFixed(0) })
          ) : (
            // A sentence with two figures inside it, so `<Trans>` rather
            // than three concatenated fragments — a translator needs to move
            // the amounts, not just the words between them.
            <Trans
              i18nKey="v3.vaults.detail.stillToGo"
              components={{
                remaining: (
                  <Numeric value={vaultRemaining(vault)} currency={vault.currencySymbol} />
                ),
                target: <Numeric value={vault.targetAmount} currency={vault.currencySymbol} />,
              }}
            />
          )}
        </p>
        <div className="self-start">
          <EditAction onClick={() => setEditingDetails(true)} />
        </div>
      </Block>

      {/* On the page, not in a card — the same reason as the group page (SC-1404). */}
      <section className="flex flex-col gap-3" aria-labelledby="vault-members-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="vault-members-heading" className="text-title">
            {t('v3.vaults.detail.inThisVault')}
          </h2>
          {holdings.length > 0 ? (
            // The short label keeps the section heading readable at 390px; the
            // full sentence stays the accessible name.
            <Button
              variant="outline"
              size="sm"
              aria-label={t('v3.vaults.detail.attachHoldings')}
              onClick={() => setAttaching(true)}
            >
              <Plus className="me-1.5 size-4" aria-hidden="true" />
              {t('v3.membership.addAction')}
            </Button>
          ) : null}
        </div>

        <V3DataView
          getId={(holding) => holding.holdingId}
          config={{
            pageKey: 'vault-members',
            data: holdings,
            nounKey: 'ui.dataView.noun.holdings',
            searchPlaceholderKey: 'ui.dataView.accounts.config.search',
            searchFn: (holding, query) =>
              [
                holding.tokenSymbol,
                holding.tokenName,
                holding.holdingLabel,
                holding.accountName,
                holding.institutionName,
              ]
                .filter(Boolean)
                .join(' ')
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            sortDefs: [
              { key: 'name', labelKey: 'ui.dataView.holdings.col.holding' },
              { key: 'value', labelKey: 'ui.dataView.holdings.col.amount' },
            ],
            defaultSort: { field: 'name', direction: 'asc' },
            sortFn: (a, b, field, direction) =>
              (field === 'value'
                ? -compareVaultHoldings(a, b)
                : a.tokenSymbol.localeCompare(b.tokenSymbol)) * (direction === 'asc' ? 1 : -1),
            renderRow: (holding) => ({
              label: [holding.tokenSymbol, holding.holdingLabel].filter(Boolean).join(' · '),
              sublabel: [holding.tokenName, holding.accountName, holding.institutionName].join(
                ' · '
              ),
              value: <VaultShareFigure holding={holding} currencySymbol={vault.currencySymbol} />,
            }),
            columns: [
              {
                key: 'holding',
                headerKey: 'ui.dataView.holdings.col.holding',
                render: (holding) => (
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-label">
                      {[holding.tokenSymbol, holding.holdingLabel].filter(Boolean).join(' · ')}
                    </span>
                    <span className="truncate text-caption text-muted-foreground">
                      {[holding.tokenName, holding.accountName, holding.institutionName].join(
                        ' · '
                      )}
                    </span>
                  </span>
                ),
              },
              {
                key: 'allocation',
                headerKey: 'ui.dataView.holdings.col.amount',
                numeric: true,
                render: (holding) => (
                  <VaultShareFigure holding={holding} currencySymbol={vault.currencySymbol} />
                ),
              },
            ],
            // The row carries the figure only; the share and Remove are the
            // peek's facts and header actions, like every other record's
            // (UI standard rules 4 and 13, SC-1433).
            peek: {
              basePath: vaultDetailPath(id),
              render: (holding) => ({
                title: [holding.tokenSymbol, holding.holdingLabel].filter(Boolean).join(' · '),
                subtitle: [holding.accountName, holding.institutionName]
                  .filter(Boolean)
                  .join(' · '),
                primary: [
                  {
                    label: t('v3.vaults.holding.inVault'),
                    value: (
                      <Numeric value={attributedValue(holding)} currency={vault.currencySymbol} />
                    ),
                  },
                  { label: t('v3.vaults.holding.shareField'), value: `${holding.percentage}%` },
                ],
                actions: (
                  <>
                    <EditVaultShareAction
                      holding={holding}
                      onSave={(holdingId, percentage) =>
                        setPercentage
                          .mutateAsync({ vaultId: id, holdingId, percentage })
                          .then(() => {})
                      }
                    />
                    <RemoveFromVaultAction
                      holding={holding}
                      currencySymbol={vault.currencySymbol}
                      onDetach={(holdingId) => detach.mutate({ vaultId: id, holdingId })}
                    />
                  </>
                ),
              }),
            },
            empty: {
              icon: Vault,
              titleKey: 'ui.dataView.vaultMembers.empty.title',
              descriptionKey: 'ui.dataView.vaultMembers.empty.description',
              action: (
                <Button onClick={() => setAttaching(true)}>
                  <Plus className="me-1.5 size-4" aria-hidden="true" />
                  {t('v3.vaults.detail.attachHoldings')}
                </Button>
              ),
            },
            renderBulkActions: (ids, clear) => (
              <ConfirmAction
                label={
                  <>
                    <CircleMinus className="me-2 size-4" aria-hidden="true" />
                    {`${t('v3.membership.removeAction')} (${ids.size})`}
                  </>
                }
                triggerClassName="text-destructive hover:text-destructive"
                confirmLabel={t('v3.membership.confirmRemove')}
                destructive
                open={confirmingRemove}
                onOpenChange={setConfirmingRemove}
                isPending={removeMany.isPending}
                consequence={t('v3.membership.removeSelection', { count: ids.size })}
                onConfirm={() =>
                  removeMany.mutate(
                    {
                      vaultId: id,
                      entries: [...ids].map((holdingId) => ({ holdingId, percentage: 0 })),
                    },
                    { onSuccess: clear }
                  )
                }
              />
            ),
          }}
        />
      </section>

      <VaultAttachSheet
        open={attaching}
        onOpenChange={setAttaching}
        vaultId={id}
        vaultName={vault.name}
        currency={baseCurrencyQuery.data?.symbol || 'USD'}
        candidates={attach.candidates}
        values={attach.values}
        allocations={attach.allocations}
        vaultNames={vaultNames}
        pending={attach.pending}
        onAttach={attach.add}
      />

      <EditVaultSheet vault={vault} open={editingDetails} onOpenChange={setEditingDetails} />

      <Block>
        <BlockHeader title={t('v3.vaults.detail.dangerZone')} />
        <div className="p-4">
          <ConfirmAction
            label={
              <>
                <Trash2 className="me-2 size-4" aria-hidden="true" />
                {t('v3.vaults.detail.deleteTrigger')}
              </>
            }
            triggerClassName="text-destructive hover:text-destructive"
            confirmLabel={t('v3.vaults.detail.deleteCommit')}
            destructive
            open={confirmingDelete}
            onOpenChange={setConfirmingDelete}
            isPending={deleteVault.isPending}
            onConfirm={() => deleteVault.mutate({ id })}
            consequence={t('v3.vaults.detail.deleteConsequence', {
              count: holdings.length,
              name: vault.name,
            })}
          />
        </div>
      </Block>
    </PageLayout>
  );
}

/** The row's figure: what this vault counts from the holding, and its share. */
function VaultShareFigure({
  holding,
  currencySymbol,
}: {
  holding: VaultHoldingRowData;
  currencySymbol: string;
}) {
  return (
    <span className="flex flex-col items-end">
      <Numeric value={attributedValue(holding)} currency={currencySymbol} className="text-label" />
      <span className="font-mono text-caption text-muted-foreground tabular-nums tracking-numeric">
        {`${holding.percentage}%`}
      </span>
    </span>
  );
}
