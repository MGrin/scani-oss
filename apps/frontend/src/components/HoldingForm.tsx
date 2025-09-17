import { zodResolver } from '@hookform/resolvers/zod';
import React, { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AccountSelector, TokenSelector } from '@/components/selectors/SearchableSelectors';
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
import { LoadingButton, LoadingSpinner } from '@/components/ui/loading';
import { useToast } from '@/hooks/use-toast';
import type { ApiAccount, ApiHolding, ApiToken } from '@/lib/api-types';
import { trpc } from '@/lib/trpc';

const HoldingFormSchema = z.object({
  accountId: z.string().min(1, 'Please select an account'),
  tokenId: z.string().min(1, 'Please select a token'),
  balance: z
    .string({
      required_error: 'Balance is required',
    })
    .refine((val) => val.trim() !== '', 'Balance is required')
    .refine((val) => !Number.isNaN(parseFloat(val)), 'Balance must be a valid number')
    .refine(
      (val) => parseFloat(val) !== 0,
      'Balance cannot be zero. Enter the actual holding amount.'
    )
    .refine(
      (val) => parseFloat(val) > 0,
      'Balance must be positive. For short positions, use a negative value with a note in the description.'
    )
    .refine(
      (val) => Math.abs(parseFloat(val)) >= 0.000001,
      'Balance is too small. Minimum value is 0.000001'
    )
    .refine(
      (val) => Math.abs(parseFloat(val)) <= 1_000_000_000,
      'Balance is too large. Maximum value is 1 billion'
    ),
});

type HoldingFormData = z.infer<typeof HoldingFormSchema>;

interface HoldingFormProps {
  isOpen: boolean;
  onClose: () => void;
  holding?: ApiHolding;
  mode: 'create' | 'edit';
}

export function HoldingForm({ isOpen, onClose, holding, mode }: HoldingFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  const balanceId = useId();

  const { data: accounts, isLoading: accountsLoading } = trpc.accounts.getAll.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery();

  const utils = trpc.useUtils();

  const createHolding = trpc.holdings.create.useMutation({
    onSuccess: (newHolding) => {
      const hasBalance = parseFloat(newHolding.balance) > 0;
      toast({
        title: 'Holding created successfully! ✅',
        description: hasBalance
          ? 'Your new holding and opening balance transaction have been added to your portfolio.'
          : 'Your new holding has been added to your portfolio.',
      });
      utils.holdings.getAll.invalidate();
      utils.users.getPortfolioValue.invalidate();
      // Invalidate transactions to show the new opening balance transaction
      if (hasBalance) {
        utils.transactions?.getAll?.invalidate?.();
      }
      handleFormReset();
      onClose();
    },
    onError: (error) => {
      console.error('Error creating holding:', error);
      toast({
        title: 'Error creating holding',
        description: error.message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const updateHolding = trpc.holdings.update.useMutation({
    onSuccess: () => {
      toast({
        title: 'Holding updated',
        description: 'Your holding has been successfully updated.',
      });
      utils.holdings.getAll.invalidate();
      utils.users.getPortfolioValue.invalidate();
      onClose();
    },
    onError: (error) => {
      toast({
        title: 'Error updating holding',
        description: error.message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<HoldingFormData>({
    resolver: zodResolver(HoldingFormSchema),
    defaultValues: {
      accountId: holding?.accountId || '',
      tokenId: holding?.tokenId || '',
      balance: holding?.balance || '',
    },
    mode: 'onChange',
  });

  // Reset form when holding changes
  React.useEffect(() => {
    if (holding) {
      reset({
        accountId: holding.accountId,
        tokenId: holding.tokenId,
        balance: holding.balance,
      });
    } else {
      reset({
        accountId: '',
        tokenId: '',
        balance: '',
      });
    }
  }, [holding, reset]);

  const watchedAccountId = watch('accountId');
  const watchedTokenId = watch('tokenId');

  // Check for duplicates when account/token changes
  const checkDuplicate = trpc.holdings.checkDuplicate.useQuery(
    {
      accountId: watchedAccountId || '',
      tokenId: watchedTokenId || '',
      excludeId: holding?.id,
    },
    {
      enabled: !!(watchedAccountId && watchedTokenId), // Enable only when both ids are present
      retry: false,
    }
  );

  // Track form changes for unsaved changes warning
  React.useEffect(() => {
    const subscription = watch(() => {
      setHasUnsavedChanges(true);
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  // Handle duplicate check results
  React.useEffect(() => {
    if (checkDuplicate.data?.exists) {
      const account = accounts?.find((a: ApiAccount) => a.id === watchedAccountId);
      const token = tokens?.find((t: ApiToken) => t.id === watchedTokenId);
      setDuplicateWarning(
        `A holding for ${token?.name || 'this token'} already exists in ${
          account?.name || 'this account'
        }. Consider updating the existing holding instead of creating a duplicate.`
      );
    } else {
      setDuplicateWarning(null);
    }
  }, [checkDuplicate.data, accounts, tokens, watchedAccountId, watchedTokenId]);

  const onSubmit = async (data: HoldingFormData) => {
    console.log('Form submitted with data:', data);
    setIsSubmitting(true);
    setHasUnsavedChanges(false); // Reset unsaved changes on submit

    const submitData = {
      accountId: data.accountId,
      tokenId: data.tokenId,
      balance: data.balance,
    };

    console.log('Submitting to backend:', submitData);

    if (mode === 'create') {
      createHolding.mutate(submitData);
    } else if (holding) {
      updateHolding.mutate({
        id: holding.id,
        data: submitData,
      });
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      if (hasUnsavedChanges && mode === 'create') {
        setIsCloseConfirmOpen(true);
        return; // Prevent closing and show confirmation dialog
      }
      handleFormReset();
      onClose();
    }
  };

  const handleConfirmClose = () => {
    setIsCloseConfirmOpen(false);
    handleFormReset();
    onClose();
  };

  const handleFormReset = () => {
    reset();
    setHasUnsavedChanges(false);
    setDuplicateWarning(null);
    setIsSubmitting(false);
  };

  const selectedToken = tokens?.find((token: ApiToken) => token.id === watchedTokenId);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-[500px] mx-4 sm:mx-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add New Holding' : 'Edit Holding'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Add a new holding to track your token balances in an account.'
              : 'Update the details of your holding.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Duplicate Warning */}
          {duplicateWarning && (
            <div className="border-yellow-200 bg-yellow-50 border rounded-md p-3">
              <p className="text-sm text-yellow-800">{duplicateWarning}</p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="account">Account *</Label>
            <AccountSelector
              value={watchedAccountId}
              onValueChange={(value) => setValue('accountId', value)}
              accounts={accounts}
              placeholder={accountsLoading ? 'Loading accounts...' : 'Select an account'}
            />
            {errors.accountId && (
              <p className="text-sm text-destructive">{errors.accountId.message}</p>
            )}
          </div>

          {/* Token Selection */}
          <div className="space-y-2">
            <Label htmlFor="token">Token *</Label>
            <TokenSelector
              value={watchedTokenId}
              onValueChange={(value) => setValue('tokenId', value)}
              tokens={tokens}
              placeholder={tokensLoading ? 'Loading tokens...' : 'Select a token'}
            />
            {errors.tokenId && <p className="text-sm text-destructive">{errors.tokenId.message}</p>}
          </div>

          {/* Balance */}
          <div className="space-y-2">
            <Label htmlFor={balanceId}>
              Balance *{' '}
              {selectedToken && (
                <span className="text-xs text-muted-foreground">({selectedToken.symbol})</span>
              )}
            </Label>
            <div className="relative">
              <Input
                id={balanceId}
                type="text"
                inputMode="decimal"
                pattern="[0-9]*\.?[0-9]*"
                {...register('balance', {
                  required: 'Balance is required',
                  setValueAs: (v) => v.toString(), // Ensure it's always a string
                })}
                placeholder={
                  selectedToken ? `Enter amount in ${selectedToken.symbol}` : 'e.g., 100.50'
                }
                className={errors.balance ? 'border-destructive focus:ring-destructive' : ''}
                disabled={isSubmitting}
              />
              {isSubmitting && (
                <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                  <LoadingSpinner size="sm" className="text-muted-foreground" />
                </div>
              )}
            </div>
            {errors.balance && <p className="text-sm text-destructive">{errors.balance.message}</p>}
            <p className="text-xs text-muted-foreground">
              Enter the current quantity you own of this asset. Must be greater than 0.000001.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              <LoadingButton
                isLoading={isSubmitting}
                loadingText={mode === 'create' ? 'Creating...' : 'Updating...'}
              >
                {mode === 'create' ? 'Create Holding' : 'Update Holding'}
              </LoadingButton>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      {/* Confirmation dialog for unsaved changes */}
      <Dialog open={isCloseConfirmOpen} onOpenChange={setIsCloseConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Are you sure you want to close without saving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCloseConfirmOpen(false)}>
              Continue Editing
            </Button>
            <Button variant="destructive" onClick={handleConfirmClose}>
              Close Without Saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
