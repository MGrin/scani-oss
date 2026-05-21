import { formatCurrency } from '@scani/shared';
import { ConfirmDialog } from '@scani/ui/components/ConfirmDialog';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Progress } from '@scani/ui/ui/progress';
import { Separator } from '@scani/ui/ui/separator';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AttachHoldingDialog } from '../components/vaults/AttachHoldingDialog';
import { VaultFormDialog } from '../components/vaults/VaultFormDialog';
import { invalidateVaultQueries } from '../hooks/invalidatePortfolioQueries';
import { V2_ROUTES } from '../lib/routes';

export function VaultDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: vault, isLoading } = trpc.vaults.getById.useQuery({ id: id! }, { enabled: !!id });
  const utils = trpc.useUtils();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showAttachHolding, setShowAttachHolding] = useState(false);
  const [editingPercentage, setEditingPercentage] = useState<string | null>(null);
  const [percentageInput, setPercentageInput] = useState('');

  const deleteMutation = trpc.vaults.delete.useMutation({
    onSuccess: () => {
      // Navigate first, invalidate in background with `'all'` so the
      // destination page refetches. Awaiting here blocked the toast +
      // navigation behind a dozen portfolio refetches.
      setShowDeleteConfirm(false);
      showSuccess('Vault deleted successfully');
      navigate(V2_ROUTES.vaults);
      void invalidateVaultQueries(utils, { refetchType: 'all' });
    },
    onError: (error) => showError(error, 'Failed to delete vault'),
  });

  const detachMutation = trpc.vaults.detachHolding.useMutation({
    onSuccess: () => {
      // Fire-and-forget invalidation: the detail page stays mounted and
      // its own active queries will refetch; blocking the toast on the
      // full portfolio refetch made the action feel sluggish.
      showSuccess('Holding removed from vault');
      void invalidateVaultQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to remove holding'),
  });

  const updatePercentageMutation = trpc.vaults.updateHoldingPercentage.useMutation({
    onSuccess: () => {
      setEditingPercentage(null);
      showSuccess('Percentage updated');
      void invalidateVaultQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to update percentage'),
  });

  const savePercentage = (holdingId: string) => {
    const pct = Number(percentageInput);
    if (pct > 0 && pct <= 100 && id) {
      updatePercentageMutation.mutate({
        vaultId: id,
        holdingId,
        percentage: pct,
      });
    }
  };

  if (!id) return null;

  if (isLoading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!vault) {
    return <p className="text-muted-foreground">Vault not found</p>;
  }

  const progress = Math.min(Number(vault.progress || 0), 100);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to={V2_ROUTES.vaults}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Vaults
          </Link>
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setShowEditDialog(true)}>
            <Pencil className="h-4 w-4 mr-1" />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setShowDeleteConfirm(true)}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Delete
          </Button>
        </div>
      </div>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full" style={{ backgroundColor: vault.color }} />
          <h2 className="text-2xl font-bold tracking-tight">{vault.name}</h2>
        </div>
      </div>

      {/* Progress */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold">
              {formatCurrency(vault.currentAmount || 0, vault.currencySymbol)}
            </span>
            <span className="text-sm text-muted-foreground">
              / {formatCurrency(vault.targetAmount, vault.currencySymbol)}
            </span>
          </div>
          <Progress value={progress} className="h-2" />
          <p className="text-sm text-muted-foreground text-right">
            {progress.toFixed(1)}% complete
          </p>
        </CardContent>
      </Card>

      <Separator />

      {/* Attached Holdings */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">Attached Holdings ({vault.holdingsCount || 0})</h3>
          <Button size="sm" variant="outline" onClick={() => setShowAttachHolding(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Attach Holding
          </Button>
        </div>
        {vault.holdings && vault.holdings.length > 0 ? (
          <div className="space-y-2">
            {[...vault.holdings]
              .sort(
                (a, b) =>
                  Number(b.attributedValue || b.holdingValue || 0) -
                  Number(a.attributedValue || a.holdingValue || 0)
              )
              .map((h) => (
                <div
                  key={h.holdingId}
                  className="flex items-center justify-between p-3 rounded-md border border-border"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{h.tokenSymbol || 'Unknown'}</span>
                      {editingPercentage === h.holdingId ? (
                        <div className="flex items-center gap-1">
                          <NumericFormat
                            value={percentageInput}
                            onValueChange={(v) => setPercentageInput(v.value)}
                            customInput={Input}
                            className="h-6 w-16 text-xs"
                            decimalScale={1}
                            allowNegative={false}
                            isAllowed={(v) =>
                              v.value === '' || (Number(v.value) > 0 && Number(v.value) <= 100)
                            }
                            suffix="%"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') savePercentage(h.holdingId);
                              if (e.key === 'Escape') setEditingPercentage(null);
                            }}
                          />
                          <Button
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => savePercentage(h.holdingId)}
                          >
                            OK
                          </Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPercentage(h.holdingId);
                            setPercentageInput(String(h.percentage));
                          }}
                          className="inline-flex items-center gap-1 hover:bg-accent rounded px-1"
                          title="Click to edit percentage"
                        >
                          <Badge variant="outline" className="text-xs">
                            {h.percentage}%
                          </Badge>
                          <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {[h.institutionName, h.accountName].filter(Boolean).join(' / ')}
                      {h.holdingValue && (
                        <span className="ml-2">
                          &middot;{' '}
                          {formatCurrency(
                            h.attributedValue || h.holdingValue,
                            vault.currencySymbol
                          )}
                        </span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground shrink-0"
                    onClick={() => detachMutation.mutate({ vaultId: id, holdingId: h.holdingId })}
                  >
                    Remove
                  </Button>
                </div>
              ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No holdings attached to this vault yet</p>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Vault"
        description={`Are you sure you want to delete "${vault.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate({ id })}
      />

      <VaultFormDialog open={showEditDialog} onOpenChange={setShowEditDialog} vaultId={id} />

      <AttachHoldingDialog
        open={showAttachHolding}
        onOpenChange={setShowAttachHolding}
        vaultId={id}
      />
    </div>
  );
}
