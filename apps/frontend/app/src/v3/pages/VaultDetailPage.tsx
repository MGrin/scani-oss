import { cn } from '@scani/ui/lib/cn';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Progress } from '@scani/ui/ui/progress';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { ArrowLeft, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { invalidateVaultQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import {
  optimisticDetachVaultHolding,
  optimisticPatchVault,
  optimisticRemoveVaults,
  optimisticSetVaultHoldingPercentage,
} from '@/v3/hooks/optimisticUpdates';
import { Field } from '../components/form/Field';
import { GroupColorChoice } from '../components/groups/GroupColorChoice';
import { MemberPicker } from '../components/membership/MemberPicker';
import { VaultHoldingRow } from '../components/vaults/VaultHoldingRow';
import { useVaultAttach } from '../hooks/useVaultAttach';
import { V3_ROUTES } from '../lib/routes';
import { compareVaultHoldings, vaultIsMet, vaultProgress, vaultRemaining } from '../lib/vaults';

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

  const [attaching, setAttaching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState<{ name: string; targetAmount: string; color: string } | null>(
    null
  );

  const attachedIds = useMemo(
    () => new Set((vaultQuery.data?.holdings ?? []).map((holding) => holding.holdingId)),
    [vaultQuery.data]
  );
  const attach = useVaultAttach(id, attachedIds);

  const updateVault = trpc.vaults.update.useMutation({
    onMutate: ({ id: vaultId, data }) =>
      optimisticPatchVault(utils, vaultId, {
        name: data.name,
        color: data.color,
        targetAmount: data.targetAmount,
      }),
    onSuccess: () => {
      setDraft(null);
      showSuccess(t('v3.vaults.detail.toast.updated'));
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.vaults.detail.toast.updating'));
    },
    onSettled: () => void invalidateVaultQueries(utils),
  });

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
        <BackLink />
        <Skeleton className="h-40 w-full" aria-hidden="true" />
      </PageLayout>
    );
  }

  const vault = vaultQuery.data;
  if (!vault) {
    return (
      <PageLayout measure="wide">
        <BackLink />
        <p className="text-body text-muted-foreground">{t('v3.vaults.detail.notFound')}</p>
      </PageLayout>
    );
  }

  const progress = vaultProgress(vault);
  const holdings = [...vault.holdings].sort(compareVaultHoldings);

  const current = draft ?? {
    name: vault.name,
    targetAmount: String(vault.targetAmount),
    color: vault.color,
  };
  const dirty =
    current.name !== vault.name ||
    current.targetAmount !== String(vault.targetAmount) ||
    current.color !== vault.color;
  const nameIsEmpty = current.name.trim().length === 0;
  const targetIsInvalid = !(Number(current.targetAmount) > 0);
  const patch = (change: Partial<typeof current>) => setDraft({ ...current, ...change });

  return (
    <PageLayout measure="wide">
      <BackLink />

      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-full"
          style={{ backgroundColor: current.color }}
        />
        <h1 className="min-w-0 truncate text-title">{vault.name}</h1>
      </div>

      <Block className="flex flex-col gap-3 p-4">
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
      </Block>

      <Block>
        <BlockHeader
          title={t('v3.vaults.detail.countingToward', { count: vault.holdingsCount || 0 })}
        />
        {holdings.length > 0 ? (
          <DataRowList className="border-border border-t">
            {holdings.map((holding) => (
              <VaultHoldingRow
                key={holding.holdingId}
                holding={holding}
                currencySymbol={vault.currencySymbol}
                isSaving={setPercentage.isPending}
                onSavePercentage={(holdingId, percentage) =>
                  setPercentage.mutate({ vaultId: id, holdingId, percentage })
                }
                onDetach={(holdingId) => detach.mutate({ vaultId: id, holdingId })}
              />
            ))}
          </DataRowList>
        ) : (
          <p className="px-4 pb-4 text-body text-muted-foreground">{t('v3.vaults.detail.empty')}</p>
        )}

        {attaching ? (
          <div className="border-border border-t">
            <MemberPicker
              candidates={attach.candidates}
              pendingIds={attach.pendingIds}
              onAdd={attach.add}
              onDone={() => setAttaching(false)}
              noun="holdings"
            />
          </div>
        ) : (
          <div className="px-4 pt-3 pb-4">
            <Button variant="outline" size="sm" onClick={() => setAttaching(true)}>
              <Plus className="me-2 size-4" aria-hidden="true" />
              {t('v3.vaults.detail.attachHolding')}
            </Button>
          </div>
        )}
      </Block>

      <Block>
        <BlockHeader title={t('v3.vaults.detail.details')} />
        <div className="flex flex-col gap-3 border-border border-t p-4">
          <Field label={t('v3.vaults.detail.name')} htmlFor="vault-name">
            <Input
              id="vault-name"
              value={current.name}
              onChange={(event) => patch({ name: event.target.value })}
              disabled={updateVault.isPending}
            />
          </Field>
          {/* The currency is not editable here, and deliberately so: it is the
           *  unit every stored figure on this vault is already denominated in,
           *  so changing it would silently reinterpret the target and the
           *  saved amount rather than convert them. */}
          <Field
            label={t('v3.vaults.detail.target')}
            htmlFor="vault-target"
            hint={t('v3.vaults.detail.targetHint', { symbol: vault.currencySymbol })}
          >
            <AmountInput
              id="vault-target"
              value={current.targetAmount}
              onValueChange={(targetAmount) => patch({ targetAmount })}
              decimalScale={2}
              disabled={updateVault.isPending}
            />
          </Field>
          <Field label={t('v3.vaults.detail.colour')}>
            <GroupColorChoice
              value={current.color}
              onChange={(color) => patch({ color })}
              disabled={updateVault.isPending}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!dirty || nameIsEmpty || targetIsInvalid || updateVault.isPending}
              onClick={() =>
                updateVault.mutate({
                  id,
                  data: {
                    name: current.name.trim(),
                    color: current.color,
                    targetAmount: current.targetAmount,
                  },
                })
              }
            >
              {t('v3.vaults.detail.saveChanges')}
            </Button>
            {dirty ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={updateVault.isPending}
                onClick={() => setDraft(null)}
              >
                {t('v3.vaults.detail.discard')}
              </Button>
            ) : null}
            {nameIsEmpty ? (
              <p className="text-caption text-muted-foreground">{t('v3.vaults.detail.needName')}</p>
            ) : targetIsInvalid ? (
              <p className="text-caption text-muted-foreground">
                {t('v3.vaults.detail.needTarget')}
              </p>
            ) : null}
          </div>
        </div>
      </Block>

      <Block>
        <BlockHeader title={t('v3.vaults.detail.dangerZone')} />
        <div className="p-4">
          <ConfirmAction
            label={t('v3.vaults.detail.deleteTrigger')}
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

function BackLink() {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="sm" asChild className="-ms-2 self-start">
      <Link to={V3_ROUTES.vaults}>
        <ArrowLeft className={cn(MIRROR_IN_RTL, 'me-2 size-4')} aria-hidden="true" />
        {t('v3.vaults.detail.backToVaults')}
      </Link>
    </Button>
  );
}
