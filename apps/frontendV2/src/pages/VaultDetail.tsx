import { Link, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const { data: vault, isLoading } = trpc.vaults.getById.useQuery({ id: id! }, { enabled: !!id });

  const { data: allHoldings } = trpc.holdings.getWithDetails.useQuery();

  const [isAttachDialogOpen, setIsAttachDialogOpen] = useState(false);
  const [selectedHoldingId, setSelectedHoldingId] = useState('');
  const [percentage, setPercentage] = useState('100');

  const attachMutation = trpc.vaults.attachHolding.useMutation({
    onSuccess: () => {
      utils.vaults.getById.invalidate({ id: id! });
      utils.vaults.getAll.invalidate();
      toast({
        title: 'Holding attached',
        description: 'The holding has been added to this vault.',
      });
      setIsAttachDialogOpen(false);
      setSelectedHoldingId('');
      setPercentage('100');
    },
    onError: (error) => showError(error, 'Attaching holding'),
  });

  const detachMutation = trpc.vaults.detachHolding.useMutation({
    onSuccess: () => {
      utils.vaults.getById.invalidate({ id: id! });
      utils.vaults.getAll.invalidate();
      toast({
        title: 'Holding detached',
        description: 'The holding has been removed from this vault.',
      });
    },
    onError: (error) => showError(error, 'Detaching holding'),
  });

  const updatePercentageMutation = trpc.vaults.updateHoldingPercentage.useMutation({
    onSuccess: () => {
      utils.vaults.getById.invalidate({ id: id! });
      utils.vaults.getAll.invalidate();
      toast({ title: 'Percentage updated' });
    },
    onError: (error) => showError(error, 'Updating percentage'),
  });

  const handleAttach = () => {
    if (!id || !selectedHoldingId) return;
    attachMutation.mutate({
      vaultId: id,
      holdingId: selectedHoldingId,
      percentage: Number.parseFloat(percentage),
    });
  };

  const handleDetach = (holdingId: string) => {
    if (!id) return;
    if (window.confirm('Remove this holding from the vault?')) {
      detachMutation.mutate({ vaultId: id, holdingId });
    }
  };

  const handlePercentageBlur = (holdingId: string, newPercentage: string) => {
    if (!id) return;
    const pct = Number.parseFloat(newPercentage);
    if (Number.isNaN(pct) || pct <= 0 || pct > 100) return;

    const currentHolding = vault?.holdings.find((h) => h.holdingId === holdingId);
    if (currentHolding && currentHolding.percentage !== pct) {
      updatePercentageMutation.mutate({ vaultId: id, holdingId, percentage: pct });
    }
  };

  const formatAmount = (amount: string, symbol?: string) => {
    const num = Number.parseFloat(amount);
    if (Number.isNaN(num)) return symbol ? `${symbol} 0` : '0';
    const formatted = num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return symbol ? `${symbol} ${formatted}` : formatted;
  };

  // Filter available holdings (exclude those already attached)
  const attachedHoldingIds = new Set(vault?.holdings.map((h) => h.holdingId) || []);
  const availableHoldings = allHoldings?.holdings.filter(
    (h) => !attachedHoldingIds.has(h.id) && !h.isHidden
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Vault not found.</p>
        <Button variant="link" onClick={() => navigate('/vaults')}>
          Back to Vaults
        </Button>
      </div>
    );
  }

  const progressClamped = Math.min(vault.progress, 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title={vault.name}
        subtitle={vault.description || undefined}
        backButton={{ onClick: () => navigate('/vaults') }}
      />

      {/* Progress Card */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 rounded-full" style={{ backgroundColor: vault.color }} />
            <div className="flex-1">
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-2xl font-bold">
                  {formatAmount(vault.currentAmount, vault.currencySymbol)}
                </span>
                <span className="text-muted-foreground">
                  of {formatAmount(vault.targetAmount, vault.currencySymbol)}
                </span>
              </div>
              <Progress value={progressClamped} className="h-3" />
              <p className="text-sm text-muted-foreground mt-2">
                {vault.progress.toFixed(1)}% of target reached
                {vault.progress >= 100 && ' 🎉'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Attached Holdings */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Attached Holdings</h2>
          <Button size="sm" onClick={() => setIsAttachDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Attach Holding
          </Button>
        </div>

        {vault.holdings.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Link className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-muted-foreground mb-3">
                No holdings attached yet. Attach holdings to track progress toward your goal.
              </p>
              <Button size="sm" onClick={() => setIsAttachDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Attach First Holding
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {vault.holdings.map((holding) => (
              <Card key={holding.holdingId}>
                <CardContent className="py-3 px-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{holding.tokenSymbol}</span>
                        <span className="text-xs text-muted-foreground truncate">
                          {holding.tokenName}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {holding.accountName} · {holding.institutionName}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="text-right">
                        <div className="text-sm font-medium">
                          {formatAmount(holding.attributedValue, vault.currencySymbol)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          of {formatAmount(holding.holdingValue, vault.currencySymbol)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          className="w-16 h-7 text-xs text-center"
                          defaultValue={holding.percentage}
                          min={0.01}
                          max={100}
                          step={1}
                          onBlur={(e) => handlePercentageBlur(holding.holdingId, e.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">%</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() => handleDetach(holding.holdingId)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Attach Holding Dialog */}
      <Dialog open={isAttachDialogOpen} onOpenChange={setIsAttachDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach Holding</DialogTitle>
            <DialogDescription>
              Select a holding and the percentage to attribute to this vault.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="holding-select">Holding</Label>
              <select
                id="holding-select"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={selectedHoldingId}
                onChange={(e) => setSelectedHoldingId(e.target.value)}
              >
                <option value="">Select a holding...</option>
                {availableHoldings?.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.token.symbol} ({h.account.name}) -{' '}
                    {Number.parseFloat(String(h.amount)).toLocaleString()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="attach-percentage">Percentage (%)</Label>
              <Input
                id="attach-percentage"
                type="number"
                min={0.01}
                max={100}
                value={percentage}
                onChange={(e) => setPercentage(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                What percentage of this holding should count toward this vault?
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAttachDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAttach} disabled={!selectedHoldingId || !percentage}>
              Attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
