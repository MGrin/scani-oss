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
      utils.vaults.invalidate();
      showSuccess('Holding attached to vault');
      onOpenChange(false);
      resetForm();
    },
    onError: (error) => showError(error, 'Failed to attach holding'),
  });

  const resetForm = () => {
    setSearch('');
    setSelectedHoldingId(null);
    setPercentage('100');
  };

  const handleSubmit = () => {
    if (!selectedHoldingId) return;
    const pct = Number(percentage);
    if (Number.isNaN(pct) || pct <= 0 || pct > 100) return;

    attachMutation.mutate({
      vaultId,
      holdingId: selectedHoldingId,
      percentage: pct,
    });
  };

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
                  className={`w-full text-left p-3 hover:bg-accent transition-colors ${
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
            <Label htmlFor="attach-percentage">Percentage (0-100)</Label>
            <NumericFormat
              id="attach-percentage"
              value={percentage}
              onValueChange={(values) => setPercentage(values.value)}
              customInput={Input}
              placeholder="100"
              decimalScale={2}
              allowNegative={false}
              isAllowed={(values) => {
                const val = Number(values.value);
                return values.value === '' || (val >= 0 && val <= 100);
              }}
              suffix="%"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              !selectedHoldingId ||
              !percentage ||
              Number(percentage) <= 0 ||
              Number(percentage) > 100 ||
              attachMutation.isPending
            }
          >
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
