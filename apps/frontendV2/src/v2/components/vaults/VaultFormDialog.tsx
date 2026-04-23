import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';

const COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#64748b',
];

interface VaultFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId?: string | null;
}

/**
 * Two-step create flow mirrors the GroupFormDialog pattern: details
 * first, then holding selection. Edit flow is still single-step since
 * attaching/detaching holdings happens from the vault detail page with
 * its per-holding percentage UI. Adding a holding-picker here would
 * duplicate that logic and complicate the edit path.
 */
type Step = 1 | 2;

export function VaultFormDialog({ open, onOpenChange, vaultId }: VaultFormDialogProps) {
  const utils = trpc.useUtils();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const { data: supportedCurrencies } = trpc.users.getSupportedCurrencies.useQuery();
  const { data: vault } = trpc.vaults.getById.useQuery({ id: vaultId! }, { enabled: !!vaultId });
  const { data: holdingsData } = trpc.holdings.getWithDetails.useQuery(undefined, {
    enabled: open && !vaultId,
  });

  const isEditMode = !!vaultId;

  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currencyId, setCurrencyId] = useState<string>('');
  const [color, setColor] = useState(COLORS[0]!);
  const [holdingSearch, setHoldingSearch] = useState('');
  const [selectedHoldingIds, setSelectedHoldingIds] = useState<Set<string>>(new Set());

  const currencyOptions = supportedCurrencies ?? [];
  const selectedCurrency = useMemo(
    () => currencyOptions.find((c) => c.id === currencyId) ?? null,
    [currencyOptions, currencyId]
  );
  const displaySymbol = selectedCurrency?.symbol ?? baseCurrency?.symbol ?? 'USD';

  const holdings = useMemo(() => {
    const list = Array.isArray(holdingsData) ? holdingsData : (holdingsData?.holdings ?? []);
    return list;
  }, [holdingsData]);

  const filteredHoldings = useMemo(() => {
    if (!holdingSearch.trim()) return holdings;
    const q = holdingSearch.toLowerCase();
    return holdings.filter(
      (h) =>
        h.token.symbol.toLowerCase().includes(q) ||
        h.token.name.toLowerCase().includes(q) ||
        h.institution?.name?.toLowerCase().includes(q) ||
        h.account?.name?.toLowerCase().includes(q)
    );
  }, [holdings, holdingSearch]);

  useEffect(() => {
    if (!open) return;
    if (vault && isEditMode) {
      setName(vault.name);
      setTargetAmount(vault.targetAmount);
      setCurrencyId(vault.currencyId);
      setColor(vault.color);
    } else if (!isEditMode) {
      setName('');
      setTargetAmount('');
      setCurrencyId(baseCurrency?.id ?? '');
      setColor(COLORS[0]!);
      setSelectedHoldingIds(new Set());
      setHoldingSearch('');
    }
    setStep(1);
  }, [open, vault, isEditMode, baseCurrency?.id]);

  const toggleHolding = (id: string) => {
    setSelectedHoldingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Attach mutation used to wire up holdings right after create. Fire
  // each attach in parallel and then invalidate once — way faster than
  // awaiting them sequentially.
  const attachMutation = trpc.vaults.attachHolding.useMutation({
    onError: (error) => showError(error, 'Failed to attach holding'),
  });

  const createMutation = trpc.vaults.create.useMutation({
    onSuccess: (created) => {
      const idsToAttach = Array.from(selectedHoldingIds);
      if (idsToAttach.length > 0) {
        // Fire-and-forget parallel attaches with equal-weight 100% — the
        // user can fine-tune percentages from the detail page if they
        // want to split a holding across multiple vaults later.
        for (const holdingId of idsToAttach) {
          attachMutation.mutate({
            vaultId: created.id,
            holdingId,
            percentage: 100,
          });
        }
      }
      onOpenChange(false);
      setName('');
      setTargetAmount('');
      setSelectedHoldingIds(new Set());
      showSuccess(
        idsToAttach.length > 0
          ? `Vault created with ${idsToAttach.length} holding(s)`
          : 'Vault created successfully'
      );
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to create vault'),
  });

  const updateMutation = trpc.vaults.update.useMutation({
    onSuccess: () => {
      onOpenChange(false);
      showSuccess('Vault updated successfully');
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to update vault'),
  });

  const handleSubmit = () => {
    if (!name.trim() || !targetAmount || !currencyId) return;

    if (isEditMode && vaultId) {
      updateMutation.mutate({
        id: vaultId,
        data: {
          name: name.trim(),
          targetAmount,
          currencyId,
          color,
        },
      });
    } else {
      createMutation.mutate({
        name: name.trim(),
        targetAmount,
        currencyId,
        color,
      });
    }
  };

  const isPending =
    createMutation.isPending || updateMutation.isPending || attachMutation.isPending;

  const canGoNext = name.trim().length > 0 && !!targetAmount && !!currencyId;

  const formatValue = (value: number, symbol?: string) =>
    `${symbol ?? baseCurrency?.symbol ?? '$'}${Number(value).toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? 'Edit Vault' : 'New Vault'}
            {!isEditMode && (
              <span className="text-muted-foreground font-normal text-sm ml-2">
                — {step === 1 ? 'Details' : 'Select Holdings'}
              </span>
            )}
          </DialogTitle>
          {!isEditMode && (
            <div className="flex gap-1 pt-2">
              {[1, 2].map((s) => (
                <div
                  key={s}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    s <= step ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              ))}
            </div>
          )}
        </DialogHeader>

        {/* Step 1: Details (always rendered in edit mode) */}
        {(isEditMode || step === 1) && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="vault-name">Name</Label>
              <Input
                id="vault-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Emergency Fund"
                disabled={isPending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="vault-target">Target Amount ({displaySymbol})</Label>
              <div className="grid grid-cols-[1fr_120px] gap-2">
                <NumericFormat
                  id="vault-target"
                  value={targetAmount}
                  onValueChange={(values) => setTargetAmount(values.value)}
                  customInput={Input}
                  placeholder="10,000"
                  thousandSeparator=","
                  decimalSeparator="."
                  decimalScale={2}
                  allowNegative={false}
                  disabled={isPending}
                />
                <Select
                  value={currencyId}
                  onValueChange={setCurrencyId}
                  disabled={isPending || currencyOptions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {currencyOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.symbol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {isEditMode && vault && currencyId !== vault.currencyId && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Changing currency will recompute the vault's current amount.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex gap-2 flex-wrap">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    disabled={isPending}
                    className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 disabled:opacity-50 disabled:pointer-events-none"
                    style={{
                      backgroundColor: c,
                      borderColor: color === c ? 'var(--foreground)' : 'transparent',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Select Holdings (create flow only) */}
        {!isEditMode && step === 2 && (
          <div className="space-y-2 py-2">
            <p className="text-xs text-muted-foreground">
              Optionally attach holdings to this vault ({selectedHoldingIds.size} selected). Each
              holding will be attached at 100%; you can adjust percentages later from the vault
              detail page.
            </p>
            <Input
              value={holdingSearch}
              onChange={(e) => setHoldingSearch(e.target.value)}
              placeholder="Search holdings..."
              className="h-8 text-xs"
              disabled={isPending}
            />
            <div className="max-h-[280px] overflow-y-auto space-y-px rounded-md border border-border p-1">
              {filteredHoldings.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="flex items-center gap-2 w-full px-2 py-2 rounded-sm hover:bg-accent text-left text-sm disabled:opacity-50 disabled:pointer-events-none"
                  onClick={() => toggleHolding(h.id)}
                  disabled={isPending}
                >
                  <Checkbox checked={selectedHoldingIds.has(h.id)} className="h-3.5 w-3.5" />
                  <span className="font-medium w-12 shrink-0">{h.token.symbol}</span>
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    {h.token.name}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                    {formatValue(h.value)}
                  </span>
                </button>
              ))}
              {filteredHoldings.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">
                  {holdings.length === 0 ? 'No holdings yet' : 'No matches'}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="flex-row justify-end sm:justify-end gap-2">
          {!isEditMode && step === 2 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep(1)}
              disabled={isPending}
              className="mr-auto"
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1" />
              Back
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          {!isEditMode && step === 1 ? (
            <Button size="sm" onClick={() => setStep(2)} disabled={!canGoNext || isPending}>
              Next
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          ) : (
            <Button size="sm" onClick={handleSubmit} disabled={!canGoNext || isPending}>
              {isEditMode ? 'Save' : 'Create'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
