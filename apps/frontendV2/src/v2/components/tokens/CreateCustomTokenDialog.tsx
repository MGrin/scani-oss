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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

type CustomToken = Awaited<
  ReturnType<ReturnType<typeof trpc.tokens.createCustom.useMutation>['mutateAsync']>
>;

interface CreateCustomTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (token: CustomToken) => void;
  initialSymbol?: string;
}

const TYPE_OPTIONS = [
  { value: 'private-company', label: 'Private Company' },
  { value: 'other', label: 'Other' },
] as const;

export function CreateCustomTokenDialog({
  open,
  onOpenChange,
  onCreated,
  initialSymbol,
}: CreateCustomTokenDialogProps) {
  const utils = trpc.useUtils();
  const { data: supportedCurrencies } = trpc.users.getSupportedCurrencies.useQuery();
  const { data: userBaseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const [symbol, setSymbol] = useState(initialSymbol ?? '');
  const [name, setName] = useState('');
  const [typeCode, setTypeCode] = useState<'private-company' | 'other'>('private-company');
  const [manualPrice, setManualPrice] = useState('');
  const [baseCurrencyCode, setBaseCurrencyCode] = useState<string>('');
  const [priceDescription, setPriceDescription] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) {
      setSymbol(initialSymbol ?? '');
      setName('');
      setTypeCode('private-company');
      setManualPrice('');
      setBaseCurrencyCode(userBaseCurrency?.symbol ?? 'USD');
      setPriceDescription('');
      setDescription('');
    }
  }, [open, initialSymbol, userBaseCurrency?.symbol]);

  const createMutation = trpc.tokens.createCustom.useMutation({
    onSuccess: (token) => {
      utils.tokens.invalidate();
      showSuccess(`Created ${token.symbol}`);
      onCreated?.(token);
      onOpenChange(false);
    },
    onError: (error) => {
      showError(error.message);
    },
  });

  const trimmedSymbol = symbol.trim().toUpperCase();
  const trimmedName = name.trim();
  const priceNum = Number(manualPrice);
  const canSubmit =
    trimmedSymbol.length > 0 &&
    trimmedName.length > 0 &&
    Number.isFinite(priceNum) &&
    priceNum > 0 &&
    baseCurrencyCode.length > 0 &&
    !createMutation.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    createMutation.mutate({
      symbol: trimmedSymbol,
      name: trimmedName,
      typeCode,
      manualPrice: priceNum,
      baseCurrencyCode,
      priceDescription: priceDescription.trim() || undefined,
      description: description.trim() || undefined,
      decimals: 2,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create custom token</DialogTitle>
          <DialogDescription>
            For assets no pricing provider tracks (e.g. private company shares). Custom tokens are
            visible to all users and any user can update the price.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div>
            <Label htmlFor="custom-token-symbol" className="text-xs">
              Symbol
            </Label>
            <Input
              id="custom-token-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="ACME"
              maxLength={20}
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="custom-token-name" className="text-xs">
              Name
            </Label>
            <Input
              id="custom-token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp shares"
              maxLength={200}
            />
          </div>

          <div>
            <Label className="text-xs">Type</Label>
            <Select
              value={typeCode}
              onValueChange={(v) => setTypeCode(v as 'private-company' | 'other')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-[1fr_120px] gap-2">
            <div>
              <Label htmlFor="custom-token-price" className="text-xs">
                Initial price
              </Label>
              <NumericFormat
                id="custom-token-price"
                customInput={Input}
                value={manualPrice}
                onValueChange={(v) => setManualPrice(v.value)}
                thousandSeparator=","
                decimalScale={8}
                allowNegative={false}
                placeholder="1234.56"
              />
            </div>
            <div>
              <Label className="text-xs">Currency</Label>
              <Select value={baseCurrencyCode} onValueChange={setBaseCurrencyCode}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {(supportedCurrencies ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.symbol}>
                      {c.symbol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="custom-token-price-desc" className="text-xs">
              Reason (optional)
            </Label>
            <Input
              id="custom-token-price-desc"
              value={priceDescription}
              onChange={(e) => setPriceDescription(e.target.value)}
              placeholder="Q4 2025 valuation round"
              maxLength={500}
            />
          </div>

          <div>
            <Label htmlFor="custom-token-description" className="text-xs">
              Description (optional)
            </Label>
            <Textarea
              id="custom-token-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notes about this asset"
              rows={2}
              maxLength={2000}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {createMutation.isPending ? 'Creating…' : 'Create token'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
