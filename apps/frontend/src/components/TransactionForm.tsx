import { zodResolver } from '@hookform/resolvers/zod';
import { FinancialMath, type Transaction } from '@scani/shared';
import { Calculator, Calendar, DollarSign, Info, Loader2, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import type { ApiAccount, ApiHolding, ApiInstitution, ApiToken } from '@/lib/api-types';
import { trpc } from '@/lib/trpc';

// Transaction type metadata - icons and additional properties
const TRANSACTION_TYPE_METADATA: Record<
  string,
  {
    icon: string;
    requiresPrice: boolean;
  }
> = {
  buy: { icon: '📈', requiresPrice: true },
  sell: { icon: '📉', requiresPrice: true },
  deposit: { icon: '💰', requiresPrice: false },
  withdrawal: { icon: '🏧', requiresPrice: false },
  dividend: { icon: '💵', requiresPrice: false },
  interest: { icon: '📊', requiresPrice: false },
  fee: { icon: '💸', requiresPrice: false },
  transfer: { icon: '↔️', requiresPrice: false },
  other: { icon: '📝', requiresPrice: false },
};

// Enhanced transaction form schema with comprehensive validation
const TransactionFormSchema = z.object({
  holdingId: z.string().min(1, 'Please select a holding/account'),
  type: z.enum([
    'buy',
    'sell',
    'deposit',
    'withdrawal',
    'dividend',
    'interest',
    'fee',
    'transfer',
    'other',
  ]),
  amount: z
    .string({
      required_error: 'Amount is required',
    })
    .refine((val) => val.trim() !== '', 'Amount is required')
    .refine((val) => !Number.isNaN(parseFloat(val)), 'Amount must be a valid number')
    .refine((val) => parseFloat(val) !== 0, 'Amount cannot be zero')
    .refine(
      (val) => Math.abs(parseFloat(val)) >= 0.01,
      'Amount is too small. Minimum value is 0.01'
    )
    .refine(
      (val) => Math.abs(parseFloat(val)) <= 1_000_000_000,
      'Amount is too large. Maximum value is 1 billion'
    ),
  fee: z
    .string({
      invalid_type_error: 'Fee must be a valid number',
    })
    .refine((val) => val === '' || !Number.isNaN(parseFloat(val)), 'Fee must be a valid number')
    .refine((val) => val === '' || parseFloat(val) >= 0, 'Fee cannot be negative')
    .refine(
      (val) => val === '' || parseFloat(val) <= 10_000,
      'Fee seems unreasonably high (max: $10K)'
    )
    .default('0'),
  description: z.string().max(500, 'Description must be at most 500 characters').optional(),
  reference: z.string().max(100, 'Reference must be at most 100 characters').optional(),
  timestamp: z.date({
    required_error: 'Transaction date is required',
    invalid_type_error: 'Invalid date',
  }),
});

type TransactionFormData = z.infer<typeof TransactionFormSchema>;

interface TransactionFormProps {
  isOpen: boolean;
  onClose: () => void;
  transaction?: Transaction;
  mode: 'create' | 'edit';
  defaultHoldingId?: string;
}

type ProcessedHolding = ApiHolding & {
  account?: ApiAccount;
  token?: ApiToken;
  institution?: ApiInstitution | null;
  displayName: string;
  balanceDisplay: string;
};

export function TransactionForm({
  isOpen,
  onClose,
  transaction,
  mode,
  defaultHoldingId,
}: TransactionFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [_showCalculator, _setShowCalculator] = useState(false);

  // Generate unique IDs for form fields
  const holdingId = useId();
  const typeId = useId();
  const amountId = useId();
  const feeId = useId();
  const descriptionId = useId();
  const referenceId = useId();
  const timestampId = useId();

  // Fetch data
  const { data: holdings, isLoading: holdingsLoading } = trpc.holdings.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const {
    data: transactionTypes,
    isLoading: transactionTypesLoading,
    error: transactionTypesError,
  } = trpc.transactionTypes.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();

  // Find user's base currency from tokens
  const baseCurrency = React.useMemo(() => {
    if (!userPrefs?.baseCurrencyId || !tokens) return null;
    return tokens.find((token) => token.id === userPrefs.baseCurrencyId) || null;
  }, [userPrefs?.baseCurrencyId, tokens]);

  const utils = trpc.useUtils();

  // Merge backend transaction types with UI metadata
  const TRANSACTION_TYPES = React.useMemo(() => {
    if (!transactionTypes) return [];

    return transactionTypes.map((type) => ({
      value: type.code,
      label: type.name,
      description: type.description || '',
      icon: TRANSACTION_TYPE_METADATA[type.code]?.icon || '📝',
      requiresPrice: TRANSACTION_TYPE_METADATA[type.code]?.requiresPrice || false,
    }));
  }, [transactionTypes]);

  // Show error if backend fails to return transaction types
  if (transactionTypesError) {
    console.error('Failed to load transaction types from backend:', transactionTypesError);
  }

  // Create maps for quick lookups
  const accountsMap = accounts
    ? Object.fromEntries(accounts.map((a: ApiAccount) => [a.id, a]))
    : {};
  const tokensMap = tokens ? Object.fromEntries(tokens.map((t: ApiToken) => [t.id, t])) : {};
  const institutionsMap = institutions
    ? Object.fromEntries(institutions.map((i: ApiInstitution) => [i.id, i]))
    : {};

  // Process holdings with account/token info for display
  const processedHoldings: ProcessedHolding[] =
    holdings?.map((holding: ApiHolding) => {
      const account = accountsMap[holding.accountId];
      const token = tokensMap[holding.tokenId];
      const institution = account ? institutionsMap[account.institutionId] : null;

      return {
        ...holding,
        account,
        token,
        institution,
        displayName: `${token?.name || 'Unknown Token'} in ${account?.name || 'Unknown Account'}`,
        balanceDisplay: `${parseFloat(holding.balance ?? '0').toFixed(
          token?.decimals || 2
        )} ${token?.symbol || ''}`,
      };
    }) || [];

  // Mutations
  const createTransaction = trpc.transactions.create.useMutation({
    onSuccess: (data) => {
      toast({
        title: '✅ Transaction created successfully!',
        description: `Your ${data?.type || 'transaction'} has been recorded.`,
      });
      utils.transactions.getAll.invalidate();
      utils.holdings.getAll.invalidate();
      utils.accounts.getAll.invalidate();
      handleFormReset();
      onClose();
    },
    onError: (error) => {
      toast({
        title: 'Error creating transaction',
        description: error.message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const updateTransaction = trpc.transactions.update.useMutation({
    onSuccess: (data) => {
      toast({
        title: '✅ Transaction updated successfully!',
        description: `Your ${data?.type || 'transaction'} has been updated.`,
      });
      utils.transactions.getAll.invalidate();
      utils.holdings.getAll.invalidate();
      utils.accounts.getAll.invalidate();
      onClose();
    },
    onError: (error) => {
      toast({
        title: 'Error updating transaction',
        description: error.message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  // Form setup
  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
    trigger,
    setError,
  } = useForm({
    resolver: zodResolver(TransactionFormSchema),
    defaultValues: {
      holdingId: transaction?.holdingId || defaultHoldingId || '',
      type: (transaction?.type as TransactionFormData['type']) || 'deposit',
      amount: transaction?.amount || '0',
      fee: transaction?.fee || '0',
      description: transaction?.description || '',
      reference: transaction?.reference || '',
      timestamp: transaction?.timestamp || new Date(),
    },
    mode: 'onChange',
  });

  // Watch form values for real-time validation and calculations
  const watchedHoldingId = watch('holdingId');
  const watchedType = watch('type');
  const watchedAmount = watch('amount');
  const watchedFee = watch('fee');

  // Get transaction type info
  const selectedTransactionType = TRANSACTION_TYPES.find((t) => t.value === watchedType);
  const selectedHolding = processedHoldings.find(
    (h: ProcessedHolding) => h.id === watchedHoldingId
  );

  // Calculate total value for transactions (simplified since price is no longer used)
  const totalValue = React.useMemo(() => {
    // Since we removed price fields, total value is primarily the amount plus fee
    if (watchedAmount && watchedFee) {
      const amount = parseFloat(watchedAmount) || 0;
      const fee = parseFloat(watchedFee) || 0;
      return FinancialMath.add(Math.abs(amount), fee);
    }
    return watchedAmount ? Math.abs(parseFloat(watchedAmount) || 0) : 0;
  }, [watchedAmount, watchedFee]);

  // Reset form when transaction changes
  useEffect(() => {
    if (transaction) {
      reset({
        holdingId: transaction.holdingId,
        type: transaction.type as TransactionFormData['type'],
        amount: transaction.amount,
        fee: transaction.fee,
        description: transaction.description || '',
        reference: transaction.reference || '',
        timestamp: new Date(transaction.timestamp),
      });
    } else {
      reset({
        holdingId: defaultHoldingId || '',
        type: 'deposit',
        amount: '0',
        fee: '0',
        description: '',
        reference: '',
        timestamp: new Date(),
      });
    }
  }, [transaction, defaultHoldingId, reset]);

  // Track form changes for unsaved changes warning
  useEffect(() => {
    const subscription = watch(() => {
      setHasUnsavedChanges(true);
    });
    return () => subscription.unsubscribe();
  }, [watch]);

  const onSubmit = async (data: TransactionFormData) => {
    // Prevent submission if transaction types failed to load
    if (transactionTypesError) {
      toast({
        title: 'Error',
        description:
          'Transaction types could not be loaded. Please refresh the page and try again.',
        variant: 'destructive',
      });
      return;
    }

    // Validate price requirement based on transaction type
    // Note: Price validation removed since we no longer use price field

    // Validate that we have the required data
    if (!data.amount || parseFloat(data.amount) === 0) {
      setError('amount', {
        type: 'manual',
        message: 'Amount is required and cannot be zero',
      });
      toast({
        title: 'Validation Error',
        description: 'Amount is required and cannot be zero',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    setHasUnsavedChanges(false);

    const submitData = {
      holdingId: data.holdingId,
      type: data.type,
      amount: data.amount,
      fee: data.fee || '0',
      description: data.description?.trim() || undefined,
      reference: data.reference?.trim() || undefined,
      timestamp: data.timestamp,
    };

    if (mode === 'create') {
      createTransaction.mutate(submitData);
    } else if (transaction) {
      updateTransaction.mutate({
        id: transaction.id,
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
          return;
        }
      }
      handleFormReset();
      onClose();
    }
  };

  const handleFormReset = useCallback(() => {
    reset();
    setHasUnsavedChanges(false);
    setIsSubmitting(false);
  }, [reset]);

  // Auto-generate description based on transaction type and holding
  const generateDescription = useCallback(() => {
    if (selectedTransactionType && selectedHolding) {
      const token = selectedHolding.token;
      const account = selectedHolding.account;

      let description = '';
      switch (watchedType) {
        case 'buy':
          description = `Buy ${token?.symbol || 'asset'} in ${account?.name || 'account'}`;
          break;
        case 'sell':
          description = `Sell ${token?.symbol || 'asset'} from ${account?.name || 'account'}`;
          break;
        case 'deposit':
          description = `Deposit to ${account?.name || 'account'}`;
          break;
        case 'withdrawal':
          description = `Withdrawal from ${account?.name || 'account'}`;
          break;
        case 'dividend':
          description = `${token?.symbol || 'Asset'} dividend payment`;
          break;
        case 'interest':
          description = `Interest earned in ${account?.name || 'account'}`;
          break;
        default:
          description = `${selectedTransactionType.label} transaction`;
      }

      setValue('description', description);
      trigger('description');
    }
  }, [selectedTransactionType, selectedHolding, watchedType, setValue, trigger]);

  if (holdingsLoading || !tokens || !accounts || !institutions) {
    return (
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? 'Add Transaction' : 'Edit Transaction'}</DialogTitle>
            <DialogDescription>Loading transaction form...</DialogDescription>
          </DialogHeader>
          <div className="flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <span>{mode === 'create' ? 'Add New Transaction' : 'Edit Transaction'}</span>
            {selectedTransactionType && (
              <span className="text-xl">{selectedTransactionType.icon}</span>
            )}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Record a new transaction to track your financial activity'
              : 'Update the details of your transaction'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Transaction Type Selection */}
          <div className="space-y-2">
            <Label htmlFor={typeId}>
              Transaction Type <span className="text-destructive">*</span>
            </Label>
            <Select
              value={watchedType}
              onValueChange={(value) => setValue('type', value as TransactionFormData['type'])}
            >
              <SelectTrigger id={typeId}>
                <SelectValue placeholder="Select transaction type" />
              </SelectTrigger>
              <SelectContent>
                {transactionTypesLoading ? (
                  <SelectItem value="loading" disabled>
                    Loading transaction types...
                  </SelectItem>
                ) : transactionTypesError ? (
                  <SelectItem value="error" disabled>
                    Error loading transaction types
                  </SelectItem>
                ) : (
                  TRANSACTION_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      <div className="flex items-center space-x-2">
                        <span>{type.icon}</span>
                        <div>
                          <div className="font-medium">{type.label}</div>
                          <div className="text-xs text-muted-foreground">{type.description}</div>
                        </div>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.type && <p className="text-sm text-destructive">{errors.type.message}</p>}

            {selectedTransactionType && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertTitle>{selectedTransactionType.label} Transaction</AlertTitle>
                <AlertDescription>{selectedTransactionType.description}</AlertDescription>
              </Alert>
            )}
          </div>

          {/* Account/Holding Selection */}
          <div className="space-y-2">
            <Label htmlFor={holdingId}>
              Account & Asset <span className="text-destructive">*</span>
            </Label>
            <Select
              value={watchedHoldingId}
              onValueChange={(value) => setValue('holdingId', value)}
            >
              <SelectTrigger id={holdingId}>
                <SelectValue placeholder="Select account and asset" />
              </SelectTrigger>
              <SelectContent>
                {processedHoldings.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    No holdings found. Please add an account and holding first.
                  </div>
                ) : (
                  processedHoldings.map((holding: ProcessedHolding) => (
                    <SelectItem key={holding.id} value={holding.id}>
                      <div className="flex flex-col">
                        <div className="font-medium">{holding.displayName}</div>
                        <div className="text-xs text-muted-foreground">
                          Balance: {holding.balanceDisplay} • {holding.institution?.name}
                        </div>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.holdingId && (
              <p className="text-sm text-destructive">{errors.holdingId.message}</p>
            )}
          </div>

          {/* Amount and Price Fields */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Amount */}
            <div className="space-y-2">
              <Label htmlFor={amountId}>
                Amount <span className="text-destructive">*</span>
                {selectedHolding && (
                  <span className="text-xs text-muted-foreground ml-2">
                    ({selectedHolding.token?.symbol})
                  </span>
                )}
              </Label>
              <div className="relative">
                <Input
                  id={amountId}
                  type="number"
                  step="any"
                  min="0.01"
                  max="1000000000"
                  {...register('amount', {
                    valueAsNumber: true,
                    required: 'Amount is required',
                    setValueAs: (value) => {
                      if (value === '' || value === null || value === undefined) return 0;
                      const num = Number(value);
                      return Number.isNaN(num) ? 0 : num;
                    },
                  })}
                  placeholder="0.00"
                  className={errors.amount ? 'border-destructive focus:ring-destructive' : ''}
                  disabled={isSubmitting}
                />
                {totalValue && (
                  <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                    <Calculator className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
              </div>
              {errors.amount && <p className="text-sm text-destructive">{errors.amount.message}</p>}
              <p className="text-xs text-muted-foreground">
                Enter the quantity for asset transactions or money amount for deposits/withdrawals
              </p>
            </div>

            {/* Price field removed - no longer needed */}
          </div>

          {/* Fee and Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Fee */}
            <div className="space-y-2">
              <Label htmlFor={feeId}>Fee (Optional)</Label>
              <div className="relative">
                <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id={feeId}
                  type="number"
                  step="0.01"
                  min="0"
                  max="10000"
                  {...register('fee', {
                    setValueAs: (value) => {
                      if (value === '' || value === null || value === undefined) return 0;
                      const num = Number(value);
                      return Number.isNaN(num) ? 0 : num;
                    },
                  })}
                  placeholder="0.00"
                  className={`pl-10 ${
                    errors.fee ? 'border-destructive focus:ring-destructive' : ''
                  }`}
                  disabled={isSubmitting}
                />
              </div>
              {errors.fee && <p className="text-sm text-destructive">{errors.fee.message}</p>}
            </div>

            {/* Date */}
            <div className="space-y-2">
              <Label htmlFor={timestampId}>
                Transaction Date <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id={timestampId}
                  type="datetime-local"
                  {...register('timestamp', {
                    setValueAs: (value) => (value ? new Date(value) : new Date()),
                  })}
                  className={`pl-10 ${
                    errors.timestamp ? 'border-destructive focus:ring-destructive' : ''
                  }`}
                  disabled={isSubmitting}
                />
              </div>
              {errors.timestamp && (
                <p className="text-sm text-destructive">{errors.timestamp.message}</p>
              )}
            </div>
          </div>

          {/* Total Value Display */}
          {totalValue && (
            <Alert>
              <Calculator className="h-4 w-4" />
              <AlertTitle>Transaction Summary</AlertTitle>
              <AlertDescription>
                <div className="space-y-1">
                  <div>
                    Amount:{' '}
                    {FinancialMath.formatCurrency(parseFloat(watchedAmount) || 0, {
                      currency: baseCurrency?.symbol,
                    })}
                  </div>
                  {watchedFee && parseFloat(watchedFee) > 0 && (
                    <div>
                      Fee:{' '}
                      {FinancialMath.formatCurrency(parseFloat(watchedFee), {
                        currency: baseCurrency?.symbol,
                      })}
                    </div>
                  )}
                  <div className="font-semibold">
                    Total:{' '}
                    {FinancialMath.formatCurrency(totalValue, {
                      currency: baseCurrency?.symbol,
                    })}
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Description */}
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Label htmlFor={descriptionId}>Description (Optional)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={generateDescription}
                className="h-6 px-2 text-xs"
                disabled={!selectedHolding || !selectedTransactionType}
              >
                <Plus className="h-3 w-3 mr-1" />
                Auto-generate
              </Button>
            </div>
            <Textarea
              id={descriptionId}
              {...register('description')}
              placeholder="Optional description for this transaction..."
              rows={3}
              maxLength={500}
              className={errors.description ? 'border-destructive focus:ring-destructive' : ''}
              disabled={isSubmitting}
            />
            {errors.description && (
              <p className="text-sm text-destructive">{errors.description.message}</p>
            )}
          </div>

          {/* Reference */}
          <div className="space-y-2">
            <Label htmlFor={referenceId}>Reference/ID (Optional)</Label>
            <Input
              id={referenceId}
              {...register('reference')}
              placeholder="e.g., check number, transaction ID"
              maxLength={100}
              className={errors.reference ? 'border-destructive focus:ring-destructive' : ''}
              disabled={isSubmitting}
            />
            {errors.reference && (
              <p className="text-sm text-destructive">{errors.reference.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              External reference number or transaction ID for your records
            </p>
          </div>

          <DialogFooter className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
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
                {mode === 'create' ? 'Create Transaction' : 'Update Transaction'}
              </LoadingButton>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
