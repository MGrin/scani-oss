import { Plus, Vault } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { VaultFormDialog } from '../components/vaults/VaultFormDialog';
import { V2_ROUTES } from '../lib/routes';

export function VaultsPage() {
  const navigate = useNavigate();
  const { data: vaults, isLoading } = trpc.vaults.getAll.useQuery();
  const [formOpen, setFormOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`skel-${i}`} className="h-36" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Vaults</h2>
          <p className="text-sm text-muted-foreground mt-1">Track savings goals</p>
        </div>
        <Button onClick={() => setFormOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          New Vault
        </Button>
      </div>

      {vaults && vaults.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...vaults]
            .sort((a, b) => Number(b.currentAmount || 0) - Number(a.currentAmount || 0))
            .map((vault) => {
              const progress = Math.min(Number(vault.progress || 0), 100);
              return (
                <Card
                  key={vault.id}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => navigate(V2_ROUTES.vaultDetail(vault.id))}
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: vault.color }}
                      />
                      {vault.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="font-semibold">
                        {vault.currencySymbol}{' '}
                        {Number(vault.currentAmount || 0).toLocaleString('en-US', {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        })}
                      </span>
                      <span className="text-muted-foreground">
                        / {vault.currencySymbol}{' '}
                        {Number(vault.targetAmount).toLocaleString('en-US', {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        })}
                      </span>
                    </div>
                    <Progress value={progress} className="h-1.5" />
                    <p className="text-xs text-muted-foreground text-right">
                      {progress.toFixed(0)}%
                    </p>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      ) : (
        <div className="text-center py-12">
          <Vault className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">No vaults yet</p>
          <Button onClick={() => setFormOpen(true)} variant="outline" className="mt-3" size="sm">
            <Plus className="h-4 w-4 mr-1" />
            Create your first vault
          </Button>
        </div>
      )}

      <VaultFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </div>
  );
}
