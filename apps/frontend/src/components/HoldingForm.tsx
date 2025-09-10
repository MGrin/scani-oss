import { zodResolver } from '@hookform/resolvers/zod';
import type { Holding } from '@scani/shared';
import React, { useId, useState } from 'react';
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
import { LoadingButton, LoadingSpinner } from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

const HoldingFormSchema = z.object({
  accountId: z.string().min(1, 'Please select an account'),
  tokenId: z.string().min(1, 'Please select a token'),
  balance: z
    .number({
      required_error: 'Balance is required',
      invalid_type_error: 'Balance must be a valid number',
    })
    .refine((val) => !Number.isNaN(val), 'Balance must be a valid number')
    .refine((val) => val !== 0, 'Balance cannot be zero. Enter the actual holding amount.')
    .refine(
      (val) => val > 0,
      'Balance must be positive. For short positions, use a negative value with a note in the description.'
    )
    .refine((val) => Math.abs(val) >= 0.000001, 'Balance is too small. Minimum value is 0.000001')
    .refine(
      (val) => Math.abs(val) <= 1_000_000_000,
      'Balance is too large. Maximum value is 1 billion'
    ),
  averageCostBasis: z
    .number({
      invalid_type_error: 'Average cost basis must be a valid number',
    })
    .positive('Average cost basis must be positive')
    .max(1_000_000, 'Average cost basis seems unreasonably high (max: $1M per unit)')
    .optional()
    .transform((val) => {
      if (val === null || val === undefined || val === 0) return undefined;
      return val;
    }),
});

type HoldingFormData = z.infer<typeof HoldingFormSchema>;

interface HoldingFormProps {
  isOpen: boolean;
  onClose: () => void;
  holding?: Holding;
  mode: 'create' | 'edit';
}

export function HoldingForm({ isOpen, onClose, holding, mode }: HoldingFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const balanceId = useId();
  const costBasisId = useId();

  const { data: accounts, isLoading: accountsLoading } = trpc.accounts.getAll.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery();

  const utils = trpc.useUtils();

  const createHolding = trpc.holdings.create.useMutation({
    onSuccess: (newHolding) => {
      const hasBalance = newHolding.balance > 0;
      toast({
        title: 'Holding created successfully! ✅',
        description: hasBalance
          ? 'Your new holding and opening balance transaction have been added to your portfolio.'
          : 'Your new holding has been added to your portfolio.',
      });
      utils.holdings.getAll.invalidate();
      // Invalidate transactions to show the new opening balance transaction
      if (hasBalance) {
        utils.transactions?.getAll?.invalidate?.();
      }
      handleFormReset();
      onClose();
    },
    onError: (error) => {
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
      balance: holding?.balance || 0,
      averageCostBasis: holding?.averageCostBasis || undefined,
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
        averageCostBasis: holding.averageCostBasis || undefined,
      });
    } else {
      reset({
        accountId: '',
        tokenId: '',
        balance: 0,
        averageCostBasis: undefined,
      });
    }
  }, [holding, reset]);

  const watchedAccountId = watch('accountId');
  const watchedTokenId = watch('tokenId');
  const watchedBalance = watch('balance');
  const watchedCostBasis = watch('averageCostBasis');

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
      const account = accounts?.find((a) => a.id === watchedAccountId);
      const token = tokens?.find((t) => t.id === watchedTokenId);
      setDuplicateWarning(
        `A holding for ${token?.name || 'this token'} already exists in ${account?.name || 'this account'}. ` +
          'Consider updating the existing holding instead of creating a duplicate.'
      );
    } else {
      setDuplicateWarning(null);
    }
  }, [checkDuplicate.data, accounts, tokens, watchedAccountId, watchedTokenId]);

  const onSubmit = async (data: HoldingFormData) => {
    setIsSubmitting(true);
    setHasUnsavedChanges(false); // Reset unsaved changes on submit

    const submitData = {
      accountId: data.accountId,
      tokenId: data.tokenId,
      balance: data.balance,
      averageCostBasis: data.averageCostBasis || undefined, // Convert null/empty to undefined
    };

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
        const confirmClose = window.confirm(
          'You have unsaved changes. Are you sure you want to close without saving?'
        );
        if (!confirmClose) {
          return; // Prevent closing
        }
      }
      handleFormReset();
      onClose();
    }
  };

  const handleFormReset = () => {
    reset();
    setHasUnsavedChanges(false);
    setDuplicateWarning(null);
    setIsSubmitting(false);
  };

  const selectedToken = tokens?.find((token) => token.id === watchedTokenId);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
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
            <Select
              value={watchedAccountId}
              onValueChange={(value) => setValue('accountId', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {accountsLoading ? (
                  <div className="p-2 text-sm text-muted-foreground">Loading accounts...</div>
                ) : accounts?.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">No accounts found</div>
                ) : (
                  accounts?.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name} ({account.type})
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.accountId && (
              <p className="text-sm text-destructive">{errors.accountId.message}</p>
            )}
          </div>

          {/* Token Selection */}
          <div className="space-y-2">
            <Label htmlFor="token">Token *</Label>
            <Select value={watchedTokenId} onValueChange={(value) => setValue('tokenId', value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a token" />
              </SelectTrigger>
              <SelectContent>
                {tokensLoading ? (
                  <div className="p-2 text-sm text-muted-foreground">Loading tokens...</div>
                ) : tokens?.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">No tokens found</div>
                ) : (
                  tokens?.map((token) => (
                    <SelectItem key={token.id} value={token.id}>
                      {token.name} ({token.symbol}) - {token.type}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
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
                type="number"
                step="any"
                min="0.000001"
                max="1000000000"
                {...register('balance', {
                  valueAsNumber: true,
                  required: 'Balance is required',
                  setValueAs: (value) => {
                    if (value === '' || value === null || value === undefined) return 0;
                    const num = Number(value);
                    return Number.isNaN(num) ? 0 : num;
                  },
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
          {/* Average Cost Basis */}
          <div className="space-y-2">
            <Label htmlFor={costBasisId}>Average Cost Basis (Optional)</Label>
            <div className="relative">
              <Input
                id={costBasisId}
                type="number"
                step="0.01"
                min="0.01"
                max="1000000"
                {...register('averageCostBasis', {
                  setValueAs: (value) => {
                    // Handle empty string or whitespace-only strings
                    if (value === '' || (typeof value === 'string' && value.trim() === '')) {
                      return undefined;
                    }
                    // Convert to number if it's a valid number
                    const num = Number(value);
                    return Number.isNaN(num) ? undefined : num;
                  },
                })}
                placeholder="e.g., 150.00 (price per unit)"
                className={
                  errors.averageCostBasis ? 'border-destructive focus:ring-destructive' : ''
                }
                disabled={isSubmitting}
              />
              {watchedCostBasis && watchedBalance && watchedBalance > 0 && (
                <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                  <span className="text-xs bg-gray-100 px-2 py-1 rounded">
                    Total: ${(watchedCostBasis * watchedBalance).toFixed(2)}
                  </span>
                </div>
              )}
            </div>
            {errors.averageCostBasis && (
              <p className="text-sm text-destructive">{errors.averageCostBasis.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              The average price you paid per unit (optional, used for performance calculations).
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
    </Dialog>
  );
}
