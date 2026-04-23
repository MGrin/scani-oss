import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '../../hooks/invalidatePortfolioQueries';
import { FiatCurrencySelect } from '../shared/FiatCurrencySelect';

interface EditCustomTokenPriceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tokenId: string;
  tokenSymbol: string;
  currentPrice: number | string | null | undefined;
  currentBaseCurrency?: string | null;
}

function formatRelative(dateStr: string): string {
  const then = new Date(dateStr).getTime();
  const diffMs = Date.now() - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function EditCustomTokenPriceDialog({
  open,
  onOpenChange,
  tokenId,
  tokenSymbol,
  currentPrice,
  currentBaseCurrency,
}: EditCustomTokenPriceDialogProps) {
  const utils = trpc.useUtils();
  const { data: userBaseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const [newPrice, setNewPrice] = useState('');
  const [baseCurrencyCode, setBaseCurrencyCode] = useState('');
  const [reason, setReason] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (open) {
      setNewPrice('');
      setBaseCurrencyCode(currentBaseCurrency ?? userBaseCurrency?.symbol ?? 'USD');
      setReason('');
    }
  }, [open, currentBaseCurrency, userBaseCurrency?.symbol]);

  const history = trpc.tokens.getPriceEditHistory.useQuery(
    { tokenId, limit: 20 },
    { enabled: open && showHistory }
  );

  const updateMutation = trpc.tokens.updateCustomPrice.useMutation({
    onSuccess: () => {
      showSuccess(`${tokenSymbol} price updated`);
      void invalidatePortfolioQueries(utils);
      void utils.tokens.getPriceEditHistory.invalidate({ tokenId });
      void utils.tokens.listCustom.invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      showError(error.message);
    },
  });

  const priceNum = Number(newPrice);
  const canSubmit =
    Number.isFinite(priceNum) &&
    priceNum > 0 &&
    baseCurrencyCode.length > 0 &&
    !updateMutation.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    updateMutation.mutate({
      tokenId,
      newPrice: priceNum,
      baseCurrencyCode,
      reason: reason.trim() || undefined,
    });
  };

  const currentPriceNum =
    typeof currentPrice === 'string' ? Number(currentPrice) : (currentPrice ?? null);
  const currentPriceCurrencyLabel = currentBaseCurrency ?? userBaseCurrency?.symbol ?? 'USD';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {tokenSymbol} price</DialogTitle>
          <DialogDescription>
            Set a new manual price in any fiat currency. Anyone in the system can edit this price;
            every change is recorded in the history below.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="text-sm text-muted-foreground">
            Current price:{' '}
            <span className="font-medium text-foreground">
              {currentPriceNum != null
                ? `${currentPriceNum.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${currentPriceCurrencyLabel}`
                : '—'}
            </span>
          </div>

          <div className="grid grid-cols-[1fr_120px] gap-2">
            <div>
              <Label htmlFor="edit-custom-price" className="text-xs">
                New price
              </Label>
              <NumericFormat
                id="edit-custom-price"
                customInput={Input}
                value={newPrice}
                onValueChange={(v) => setNewPrice(v.value)}
                thousandSeparator=","
                decimalScale={8}
                allowNegative={false}
                placeholder="Enter a positive number"
                autoFocus
              />
            </div>
            <div>
              <Label className="text-xs">Currency</Label>
              <FiatCurrencySelect
                value={baseCurrencyCode}
                onChange={setBaseCurrencyCode}
                valueField="symbol"
                variant="compact"
                placeholder="—"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="edit-custom-reason" className="text-xs">
              Reason (optional)
            </Label>
            <Textarea
              id="edit-custom-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What changed? e.g. Q4 2025 valuation round"
              rows={2}
              maxLength={500}
            />
          </div>

          <div>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? 'Hide history' : 'Show edit history'}
            </button>

            {showHistory && (
              <div className="mt-2 border rounded-md max-h-52 overflow-y-auto text-xs divide-y">
                {history.isLoading && (
                  <div className="px-3 py-2 text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading history…
                  </div>
                )}
                {!history.isLoading && (history.data?.length ?? 0) === 0 && (
                  <div className="px-3 py-2 text-muted-foreground">No edits yet.</div>
                )}
                {history.data?.map((row) => {
                  const prev =
                    row.previousPrice != null
                      ? Number(row.previousPrice).toLocaleString('en-US', {
                          maximumFractionDigits: 8,
                        })
                      : '—';
                  const next = Number(row.newPrice).toLocaleString('en-US', {
                    maximumFractionDigits: 8,
                  });
                  const editor = row.editorEmail ?? row.editorName ?? 'unknown';
                  const currency = row.baseCurrencySymbol ?? '';
                  return (
                    <div key={row.id} className="px-3 py-2 flex flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono">
                          {prev} → {next} {currency}
                        </span>
                        <span className="text-muted-foreground">
                          {formatRelative(new Date(row.createdAt).toISOString())}
                        </span>
                      </div>
                      <div className="text-muted-foreground flex items-center justify-between gap-2">
                        <span className="truncate">{row.reason ?? 'No reason given'}</span>
                        <span className="truncate">{editor}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {updateMutation.isPending ? 'Saving…' : 'Save price'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
