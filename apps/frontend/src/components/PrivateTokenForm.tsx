import { zodResolver } from '@hookform/resolvers/zod';
import { manualPriceMinimum, privateTokenCreateSchema } from '@scani/shared';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import {
  ManualPriceField,
  PriceDescriptionField,
  TokenDescriptionField,
} from '@/components/tokens/fields';
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
import { useToast } from '@/hooks/use-toast';
import { withOptimisticHandlers } from '@/lib/cache/optimistic/entityManager';
import { trpc } from '@/lib/trpc';
import { normalizeSymbol } from '@/lib/utils';

type PrivateTokenFormValues = z.infer<typeof privateTokenCreateSchema>;

interface PrivateTokenFormProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  token?: {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    typeId: string;
  } | null;
  onSuccess?: (token: { id: string; symbol: string; name: string }) => void;
}

const DEFAULT_VALUES: PrivateTokenFormValues = {
  symbol: '',
  name: '',
  decimals: 2,
  typeCode: 'private-company',
  description: '',
  manualPrice: manualPriceMinimum,
  priceDescription: '',
};

export function PrivateTokenForm({
  isOpen,
  onClose,
  mode,
  token,
  onSuccess,
}: PrivateTokenFormProps) {
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const form = useForm<PrivateTokenFormValues>({
    resolver: zodResolver(privateTokenCreateSchema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onBlur',
  });

  const createToken = trpc.tokens.create.useMutation(
    withOptimisticHandlers('token', 'create', utils, {
      onSuccess: (data) => {
        toast({
          title: '✅ Token created successfully!',
          description: 'The private token has been added to your portfolio.',
        });

        if (onSuccess && data) {
          onSuccess({
            id: data.id,
            symbol: data.symbol,
            name: data.name || data.symbol,
          });
        }

        form.reset(DEFAULT_VALUES);
        onClose();
      },
      onError: (error) => {
        toast({
          title: 'Error creating token',
          description: error.message,
          variant: 'destructive',
        });
      },
    })
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (mode === 'edit' && token) {
      form.reset({
        ...DEFAULT_VALUES,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        typeCode: token.typeId === 'other' ? 'other' : 'private-company',
      });
    } else {
      form.reset(DEFAULT_VALUES);
    }
  }, [form, isOpen, mode, token]);

  const onSubmit = async (values: PrivateTokenFormValues) => {
    try {
      const payload = {
        symbol: normalizeSymbol(values.symbol),
        name: values.name,
        decimals: values.decimals,
        typeId: values.typeCode,
        description: values.description ?? '',
        manualPrice: values.manualPrice,
        priceDescription: values.priceDescription ?? '',
      };

      if (mode === 'create') {
        await createToken.mutateAsync(payload);
      } else {
        // Editing private tokens uses dedicated update form
        console.warn('PrivateTokenForm edit mode is not supported.');
      }
    } catch (error) {
      console.error('Token creation failed:', error);
    }
  };

  const manualPriceError = form.formState.errors.manualPrice?.message;
  const priceDescriptionError = form.formState.errors.priceDescription?.message;

  const typeOptions = useMemo(
    () => [
      {
        value: 'private-company' as const,
        label: 'Private Company',
        description: 'Unlisted company shares or equity',
      },
      {
        value: 'other' as const,
        label: 'Other',
        description: 'Custom assets, collectibles, etc.',
      },
    ],
    []
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] sm:max-w-[600px] mx-4 sm:mx-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Create Private Token' : 'Edit Private Token'}
          </DialogTitle>
          <DialogDescription>
            Create a custom token for private companies or other unlisted assets. You can set a
            manual price for accurate portfolio valuation.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="symbol">Symbol *</Label>
            <Input
              {...form.register('symbol')}
              placeholder="e.g., MY-COMPANY, STARTUP-XYZ"
              className={form.formState.errors.symbol ? 'border-destructive' : ''}
              onChange={(event) => {
                form.setValue('symbol', normalizeSymbol(event.target.value));
              }}
            />
            {form.formState.errors.symbol && (
              <p className="text-sm text-destructive">{form.formState.errors.symbol.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              {...form.register('name')}
              placeholder="e.g., My Private Company Inc."
              className={form.formState.errors.name ? 'border-destructive' : ''}
            />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="typeCode">Token Type *</Label>
            <Select
              value={form.watch('typeCode')}
              onValueChange={(value: 'private-company' | 'other') =>
                form.setValue('typeCode', value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select token type" />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex flex-col items-start">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.typeCode && (
              <p className="text-sm text-destructive">{form.formState.errors.typeCode.message}</p>
            )}
          </div>

          <ManualPriceField
            label="Current Price (USD) *"
            registration={form.register('manualPrice', { valueAsNumber: true })}
            errorMessage={manualPriceError}
            helperText="Set the current value per token. This will be used for portfolio calculations."
            min={manualPriceMinimum}
            placeholder="e.g., 1000.00"
          />

          <PriceDescriptionField
            label="Price Notes (Optional)"
            registration={form.register('priceDescription')}
            errorMessage={priceDescriptionError}
            helperText="Optional notes about how this price was determined."
            placeholder="e.g., Based on latest valuation round, Q3 2025"
          />

          <div className="space-y-2">
            <Label htmlFor="decimals">Decimal Places</Label>
            <Input
              type="number"
              min="0"
              max="18"
              {...form.register('decimals', { valueAsNumber: true })}
              className={form.formState.errors.decimals ? 'border-destructive' : ''}
            />
            {form.formState.errors.decimals && (
              <p className="text-sm text-destructive">{form.formState.errors.decimals.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Number of decimal places for this token (0-18, typically 0-8).
            </p>
          </div>

          <TokenDescriptionField
            label="Description (Optional)"
            registration={form.register('description')}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createToken.isLoading}
              className="flex items-center gap-2"
            >
              {createToken.isLoading && (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-background border-t-foreground" />
              )}
              {mode === 'create' ? 'Create Token' : 'Update Token'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
