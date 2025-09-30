import { zodResolver } from '@hookform/resolvers/zod';
import { manualPriceMinimum, privateTokenUpdateSchema } from '@scani/shared';
import { useEffect } from 'react';
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
import { useToast } from '@/hooks/use-toast';
import { withOptimisticHandlers } from '@/lib/cache/optimistic/entityManager';
import { trpc } from '@/lib/trpc';

type UpdatePrivateTokenFormValues = z.infer<typeof privateTokenUpdateSchema>;

interface UpdatePrivateTokenFormProps {
  isOpen: boolean;
  onClose: () => void;
  token: {
    id: string;
    symbol: string;
    name: string;
  } | null;
  onSuccess?: () => void;
}

const DEFAULT_VALUES: UpdatePrivateTokenFormValues = {
  description: '',
  manualPrice: undefined,
  priceDescription: '',
};

export function UpdatePrivateTokenForm({
  isOpen,
  onClose,
  token,
  onSuccess,
}: UpdatePrivateTokenFormProps) {
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const form = useForm<UpdatePrivateTokenFormValues>({
    resolver: zodResolver(privateTokenUpdateSchema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onBlur',
  });

  const updateToken = trpc.tokens.update.useMutation(
    withOptimisticHandlers('token', 'update', utils, {
      onSuccess: () => {
        toast({
          title: '✅ Token updated successfully!',
          description: 'The private token has been updated.',
        });

        onSuccess?.();
        form.reset(DEFAULT_VALUES);
        onClose();
      },
      onError: (error) => {
        toast({
          title: 'Error updating token',
          description: error.message,
          variant: 'destructive',
        });
      },
    })
  );

  useEffect(() => {
    if (isOpen) {
      form.reset(DEFAULT_VALUES);
    }
  }, [form, isOpen]);

  const onSubmit = async (values: UpdatePrivateTokenFormValues) => {
    if (!token) {
      return;
    }

    try {
      await updateToken.mutateAsync({
        id: token.id,
        data: values,
      });
    } catch (error) {
      console.error('Token update failed:', error);
    }
  };

  const manualPriceError = form.formState.errors.manualPrice?.message;
  const priceDescriptionError = form.formState.errors.priceDescription?.message;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] sm:max-w-[500px] mx-4 sm:mx-auto">
        <DialogHeader>
          <DialogTitle>Update {token?.symbol}</DialogTitle>
          <DialogDescription>
            Update the description and current price for your private token. Changes will be
            reflected in your portfolio calculations.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <TokenDescriptionField
            label="Token Description"
            registration={form.register('description')}
            helperText="Update the description for your records and portfolio notes."
            placeholder="e.g., Private equity investment in Series A"
          />

          <ManualPriceField
            label="New Current Price (USD)"
            registration={form.register('manualPrice', { valueAsNumber: true })}
            errorMessage={manualPriceError}
            helperText="Leave empty to keep the current price. Adding a value will create a new price entry with today's date."
            min={manualPriceMinimum}
            placeholder="e.g., 1250.00"
          />

          <PriceDescriptionField
            label="Price Update Notes"
            registration={form.register('priceDescription')}
            errorMessage={priceDescriptionError}
            helperText="Required when providing a new price. Add context like valuation source or effective date."
            placeholder="e.g., Updated based on Q4 2025 valuation"
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={updateToken.isLoading}
              className="flex items-center gap-2"
            >
              {updateToken.isLoading && (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-background border-t-foreground" />
              )}
              Update Token
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
