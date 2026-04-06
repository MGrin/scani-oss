import { ArrowLeft, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

export function VaultDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: vault, isLoading } = trpc.vaults.getById.useQuery({ id: id! }, { enabled: !!id });
  const utils = trpc.useUtils();

  const deleteMutation = trpc.vaults.delete.useMutation({
    onSuccess: () => {
      utils.vaults.invalidate();
      navigate(V2_ROUTES.vaults);
    },
  });

  const detachMutation = trpc.vaults.detachHolding.useMutation({
    onSuccess: () => utils.vaults.invalidate(),
  });

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
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => deleteMutation.mutate({ id })}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Delete
        </Button>
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
              {vault.currencySymbol}{' '}
              {Number(vault.currentAmount || 0).toLocaleString('en-US', {
                minimumFractionDigits: 2,
              })}
            </span>
            <span className="text-sm text-muted-foreground">
              / {vault.currencySymbol}{' '}
              {Number(vault.targetAmount).toLocaleString('en-US', {
                minimumFractionDigits: 2,
              })}
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
        <h3 className="text-sm font-medium mb-3">Attached Holdings ({vault.holdingsCount || 0})</h3>
        {vault.holdings && vault.holdings.length > 0 ? (
          <div className="space-y-2">
            {vault.holdings.map(
              (h: { holdingId: string; percentage: number; tokenSymbol?: string }) => (
                <div
                  key={h.holdingId}
                  className="flex items-center justify-between p-3 rounded-md border border-border"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{h.tokenSymbol || 'Unknown'}</span>
                    <Badge variant="outline" className="text-xs">
                      {h.percentage}%
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => detachMutation.mutate({ vaultId: id, holdingId: h.holdingId })}
                  >
                    Remove
                  </Button>
                </div>
              )
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No holdings attached to this vault yet</p>
        )}
      </div>
    </div>
  );
}
