import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
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
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

// Form schema for private tokens
const PrivateTokenFormSchema = z.object({
  symbol: z.string().min(1, 'Symbol is required').max(20, 'Symbol must be 20 characters or less'),
  name: z.string().min(1, 'Name is required'),
  decimals: z.number().int().min(0).max(18),
  specificType: z.enum(['private-company', 'other'], {
    required_error: 'Please select a token type',
  }),
  description: z.string().optional(),
  manualPrice: z.number().min(0.000001, 'Price must be greater than 0'),
  priceDescription: z.string().optional(),
});

type PrivateTokenFormData = z.infer<typeof PrivateTokenFormSchema>;

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

export function PrivateTokenForm({
  isOpen,
  onClose,
  mode,
  token,
  onSuccess,
}: PrivateTokenFormProps) {
  const { toast } = useToast();

  const form = useForm<PrivateTokenFormData>({
    resolver: zodResolver(PrivateTokenFormSchema),
    defaultValues: {
      symbol: '',
      name: '',
      decimals: 2,
      specificType: 'private-company',
      description: '',
      manualPrice: undefined,
      priceDescription: '',
    },
  });

  // TRPC mutations
  const createToken = trpc.tokens.create.useMutation({
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

      onClose();
      form.reset();
    },
    onError: (error) => {
      toast({
        title: 'Error creating token',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Populate form when editing
  useEffect(() => {
    if (mode === 'edit' && token) {
      form.reset({
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        specificType: token.typeId === 'other' ? 'other' : 'private-company',
        description: '',
        manualPrice: undefined,
        priceDescription: '',
      });
    } else {
      form.reset({
        symbol: '',
        name: '',
        decimals: 2,
        specificType: 'private-company',
        description: '',
        manualPrice: undefined,
        priceDescription: '',
      });
    }
  }, [mode, token, form]);

  const onSubmit = async (data: PrivateTokenFormData) => {
    try {
      // Create token data
      const tokenData = {
        symbol: data.symbol.toUpperCase(),
        name: data.name,
        decimals: data.decimals,
        typeId: data.specificType, // This will be 'private-company' or 'other'
        description: data.description || '',
        manualPrice: data.manualPrice,
        priceDescription: data.priceDescription || '',
      };

      console.log('Creating private token:', tokenData);

      if (mode === 'create') {
        await createToken.mutateAsync(tokenData);
      } else {
        // TODO: Add edit mutation when needed
        console.log('Edit mode not implemented yet');
      }
    } catch (error) {
      console.error('Token creation failed:', error);
      // Error is already handled by mutation onError
    }
  };

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
          {/* Symbol Input */}
          <div className="space-y-2">
            <Label htmlFor="symbol">Symbol *</Label>
            <Input
              {...form.register('symbol')}
              placeholder="e.g., MY-COMPANY, STARTUP-XYZ"
              className={form.formState.errors.symbol ? 'border-destructive' : ''}
              onChange={(e) => {
                form.setValue('symbol', e.target.value.toUpperCase());
              }}
            />
            {form.formState.errors.symbol && (
              <p className="text-sm text-destructive">{form.formState.errors.symbol.message}</p>
            )}
          </div>

          {/* Name Input */}
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

          {/* Token Type Selection */}
          <div className="space-y-2">
            <Label htmlFor="specificType">Token Type *</Label>
            <Select
              value={form.watch('specificType')}
              onValueChange={(value: 'private-company' | 'other') =>
                form.setValue('specificType', value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select token type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private-company">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">Private Company</span>
                    <span className="text-xs text-muted-foreground">
                      Unlisted company shares or equity
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="other">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">Other</span>
                    <span className="text-xs text-muted-foreground">
                      Custom assets, collectibles, etc.
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            {form.formState.errors.specificType && (
              <p className="text-sm text-destructive">
                {form.formState.errors.specificType.message}
              </p>
            )}
          </div>

          {/* Manual Price Input */}
          <div className="space-y-2">
            <Label htmlFor="manualPrice">Current Price (USD) *</Label>
            <Input
              type="number"
              step="0.000001"
              min="0.000001"
              placeholder="e.g., 1000.00"
              {...form.register('manualPrice', { valueAsNumber: true })}
              className={form.formState.errors.manualPrice ? 'border-destructive' : ''}
            />
            {form.formState.errors.manualPrice && (
              <p className="text-sm text-destructive">
                {form.formState.errors.manualPrice.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Set the current value per token. This will be used for portfolio calculations.
            </p>
          </div>

          {/* Price Description */}
          <div className="space-y-2">
            <Label htmlFor="priceDescription">Price Notes (Optional)</Label>
            <Input
              {...form.register('priceDescription')}
              placeholder="e.g., Based on latest valuation round, Q3 2025"
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Optional notes about how this price was determined.
            </p>
          </div>

          {/* Decimals Input */}
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

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              {...form.register('description')}
              placeholder="Additional notes about this token..."
              className="min-h-[80px]"
            />
          </div>

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
