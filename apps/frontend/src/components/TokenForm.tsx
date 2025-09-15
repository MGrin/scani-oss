import { zodResolver } from '@hookform/resolvers/zod';

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
import { LoadingButton } from '@/components/ui/loading';
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

// Token categories for the UI - restricted to private tokens only
type TokenCategory = 'private';

// Form schema
const TokenFormSchema = z.object({
  category: z.enum(['private']),
  symbol: z.string().min(1, 'Symbol is required').max(20, 'Symbol must be 20 characters or less'),
  name: z.string().min(1, 'Name is required for private tokens'),
  decimals: z.number().int().min(0).max(18),
  specificType: z.string().min(1, 'Token type is required'), // private-company or other
  description: z.string().optional(),
  manualPrice: z.number().min(0.000001, 'Price must be greater than 0'),
});

type TokenFormData = z.infer<typeof TokenFormSchema>;

interface TokenFormProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  token?: {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    typeId: string;
  }; // For edit mode
  onSuccess?: (token: { id: string; symbol: string; name: string }) => void; // Callback for successful creation
}

export function TokenForm({ isOpen, onClose, mode, onSuccess }: TokenFormProps) {
  const { toast } = useToast();

  const form = useForm<TokenFormData>({
    resolver: zodResolver(TokenFormSchema),
    defaultValues: {
      category: 'private',
      decimals: 2,
      symbol: '',
      name: '',
      description: '',
      specificType: 'private-company',
      manualPrice: 0,
    },
  });

  const watchedCategory = form.watch('category');

  // TRPC mutations and queries
  const createToken = trpc.tokens.create.useMutation({
    onSuccess: (data) => {
      toast({
        title: '✅ Token created successfully!',
        description: 'The token has been added to your available assets.',
      });

      // Call the onSuccess callback if provided
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

  // No auto-validation needed for private tokens

  const onSubmit = async (data: TokenFormData) => {
    try {
      const tokenData = {
        symbol: data.symbol.toUpperCase(),
        decimals: data.decimals,
        name: data.name,
        typeId: data.specificType === 'other' ? 'other' : 'private-company',
        manualPrice: data.manualPrice,
        description: data.description,
      };

      await createToken.mutateAsync(tokenData);
    } catch (error) {
      console.error('Token creation failed:', error);
      // Error handled by mutation onError
    }
  };

  const handleClose = () => {
    form.reset();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create New Token' : 'Edit Token'}</DialogTitle>
          <DialogDescription>
            Add a new token to track in your portfolio. Choose the appropriate category for
            automatic data fetching.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Token Category Selection */}
          <div className="space-y-2">
            <Label htmlFor="category">Token Category *</Label>
            <Select
              value={watchedCategory}
              onValueChange={(value: TokenCategory) => form.setValue('category', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select token category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">
                  <div className="flex flex-col items-start">
                    <span className="font-medium">Private Company / Other</span>
                    <span className="text-xs text-muted-foreground">
                      Create custom tokens for private assets
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

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
              placeholder="Enter token name"
              className={form.formState.errors.name ? 'border-destructive' : ''}
            />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          {/* Token Type Selection */}
          <div className="space-y-2">
            <Label htmlFor="specificType">Type *</Label>
            <Select
              value={form.watch('specificType') || ''}
              onValueChange={(value) => form.setValue('specificType', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private-company">Private Company</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Decimals */}
          <div className="space-y-2">
            <Label htmlFor="decimals">Decimals</Label>
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
          </div>

          {/* Manual Price */}
          <div className="space-y-2">
            <Label htmlFor="manualPrice">Current Price *</Label>
            <Input
              type="number"
              min="0.000001"
              step="0.000001"
              {...form.register('manualPrice', { valueAsNumber: true })}
              placeholder="0.00"
              className={form.formState.errors.manualPrice ? 'border-destructive' : ''}
            />
            {form.formState.errors.manualPrice && (
              <p className="text-sm text-destructive">
                {form.formState.errors.manualPrice.message}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              {...form.register('description')}
              placeholder="Optional description of the asset"
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createToken.isPending || !form.formState.isValid}>
              <LoadingButton
                isLoading={createToken.isPending}
                loadingText={mode === 'create' ? 'Creating...' : 'Updating...'}
              >
                {mode === 'create' ? 'Create Token' : 'Update Token'}
              </LoadingButton>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
