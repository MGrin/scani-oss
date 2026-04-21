import { useMemo, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';

interface AttachHoldingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
}

export function AttachHoldingDialog({ open, onOpenChange, vaultId }: AttachHoldingDialogProps) {
  const utils = trpc.useUtils();
  const { data: holdingsData } = trpc.holdings.getWithDetails.useQuery(undefined, {
    enabled: open,
  });

  const [search, setSearch] = useState('');
  const [selectedHoldingId, setSelectedHoldingId] = useState<string | null>(null);
  const [percentage, setPercentage] = useState('100');

  const holdings = useMemo(() => {
    const list = Array.isArray(holdingsData) ? holdingsData : (holdingsData?.holdings ?? []);
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (h) =>
        h.token.symbol.toLowerCase().includes(q) ||
        h.token.name.toLowerCase().includes(q) ||
        h.account?.name?.toLowerCase().includes(q) ||
        h.institution?.name?.toLowerCase().includes(q)
    );
  }, [holdingsData, search]);

  const attachMutation = trpc.vaults.attachHolding.useMutation({
    onSuccess: () => {
      showSuccess('Holding attached to vault');
      onOpenChange(false);
      resetForm();
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to attach holding'),
  });

  const resetForm = () => {
    setSearch('');
    setSelectedHoldingId(null);
    setPercentage('100');
  };

  // Query existing vault allocations for the selected holding
  const { data: holdingVaults } = trpc.vaults.getByHoldingId.useQuery(
    { holdingId: selectedHoldingId! },
    { enabled: !!selectedHoldingId }
  );

  // Calculate how much percentage is already allocated to OTHER vaults
  const alreadyAllocated = useMemo(() => {
    if (!holdingVaults) return 0;
    return holdingVaults
      .filter((v) => v.id !== vaultId) // exclude current vault
      .reduce((sum, v) => sum + (v.percentage ?? 0), 0);
  }, [holdingVaults, vaultId]);

  const maxPercentage = Math.max(0, 100 - alreadyAllocated);

  const handleSubmit = () => {
    if (!selectedHoldingId) return;
    const pct = Number(percentage);
    if (Number.isNaN(pct) || pct <= 0 || pct > maxPercentage) return;

    attachMutation.mutate({
      vaultId,
      holdingId: selectedHoldingId,
      percentage: pct,
    });
  };

  const isPending = attachMutation.isPending;

  const formatValue = (value: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (isPending) return;
        if (!o) resetForm();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach Holding</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Search Holdings</Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by symbol, name, account..."
              disabled={isPending}
            />
          </div>

          <div className="max-h-60 overflow-y-auto border rounded-md divide-y">
            {holdings.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3 text-center">No holdings found</p>
            ) : (
              holdings.slice(0, 50).map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setSelectedHoldingId(h.id)}
                  disabled={isPending}
                  className={`w-full text-left p-3 hover:bg-accent transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                    selectedHoldingId === h.id ? 'bg-accent' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium">{h.token.symbol}</span>
                      <span className="text-xs text-muted-foreground ml-2">{h.token.name}</span>
                    </div>
                    <span className="text-sm tabular-nums">{formatValue(h.value)}</span>
                  </div>
                  {(h.institution?.name || h.account?.name) && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {h.institution?.name}
                      {h.account?.name && ` / ${h.account.name}`}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="attach-percentage">
              Percentage{' '}
              {selectedHoldingId && alreadyAllocated > 0 && (
                <span className="text-muted-foreground font-normal">
                  (max {maxPercentage}% — {alreadyAllocated}% in other vaults)
                </span>
              )}
            </Label>
            <NumericFormat
              id="attach-percentage"
              value={percentage}
              onValueChange={(values) => setPercentage(values.value)}
              customInput={Input}
              placeholder={String(maxPercentage)}
              decimalScale={2}
              allowNegative={false}
              isAllowed={(values) => {
                const val = Number(values.value);
                return values.value === '' || (val >= 0 && val <= maxPercentage);
              }}
              suffix="%"
              disabled={isPending}
            />
            {maxPercentage === 0 && selectedHoldingId && (
              <p className="text-xs text-destructive">
                This holding is already 100% allocated to other vaults.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              !selectedHoldingId ||
              !percentage ||
              Number(percentage) <= 0 ||
              Number(percentage) > 100 ||
              isPending
            }
          >
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
