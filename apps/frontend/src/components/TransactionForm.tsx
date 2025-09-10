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
import { trpc } from '@/lib/trpc';

// Transaction types with user-friendly labels and descriptions
const TRANSACTION_TYPES = [
  {
    value: 'buy',
    label: 'Buy',
    description: 'Purchase an asset (decreases cash, increases holdings)',
    icon: '📈',
    requiresPrice: true,
  },
  {
    value: 'sell',
    label: 'Sell',
    description: 'Sell an asset (increases cash, decreases holdings)',
    icon: '📉',
    requiresPrice: true,
  },
  {
    value: 'deposit',
    label: 'Deposit',
    description: 'Add money to account (salary, transfer in)',
    icon: '💰',
    requiresPrice: false,
  },
  {
    value: 'withdrawal',
    label: 'Withdrawal',
    description: 'Remove money from account (ATM, transfer out)',
    icon: '🏧',
    requiresPrice: false,
  },
  {
    value: 'dividend',
    label: 'Dividend',
    description: 'Dividend payment from stocks or funds',
    icon: '💵',
    requiresPrice: false,
  },
  {
    value: 'interest',
    label: 'Interest',
    description: 'Interest earned on deposits or bonds',
    icon: '📊',
    requiresPrice: false,
  },
  {
    value: 'fee',
    label: 'Fee',
    description: 'Account fee or transaction cost',
    icon: '💸',
    requiresPrice: false,
  },
  {
    value: 'transfer',
    label: 'Transfer',
    description: 'Move funds between accounts',
    icon: '↔️',
    requiresPrice: false,
  },
  {
    value: 'other',
    label: 'Other',
    description: 'Other transaction type',
    icon: '📝',
    requiresPrice: false,
  },
] as const;

// Enhanced transaction form schema with comprehensive validation
const TransactionFormSchema = z
  .object({
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
      .number({
        required_error: 'Amount is required',
        invalid_type_error: 'Amount must be a valid number',
      })
      .refine((val) => !Number.isNaN(val), 'Amount must be a valid number')
      .refine((val) => val !== 0, 'Amount cannot be zero')
      .refine((val) => Math.abs(val) >= 0.01, 'Amount is too small. Minimum value is 0.01')
      .refine(
        (val) => Math.abs(val) <= 1_000_000_000,
        'Amount is too large. Maximum value is 1 billion'
      ),
    price: z
      .number({
        invalid_type_error: 'Price must be a valid number',
      })
      .positive('Price must be positive')
      .max(1_000_000, 'Price seems unreasonably high (max: $1M per unit)')
      .optional()
      .transform((val) => {
        if (val === null || val === undefined || val === 0) return undefined;
        return val;
      }),
    fee: z.coerce
      .number({
        invalid_type_error: 'Fee must be a valid number',
      })
      .min(0, 'Fee cannot be negative')
      .max(10_000, 'Fee seems unreasonably high (max: $10K)')
      .default(0),
    description: z.string().max(500, 'Description must be at most 500 characters').optional(),
    reference: z.string().max(100, 'Reference must be at most 100 characters').optional(),
    timestamp: z.date({
      required_error: 'Transaction date is required',
      invalid_type_error: 'Invalid date',
    }),
  })
  .refine(
    (data) => {
      const transactionType = TRANSACTION_TYPES.find((t) => t.value === data.type);
      if (transactionType?.requiresPrice && !data.price) {
        return false;
      }
      return true;
    },
    {
      message: 'Price is required for buy/sell transactions',
      path: ['price'],
    }
  );

type TransactionFormData = z.infer<typeof TransactionFormSchema>;

interface TransactionFormProps {
  isOpen: boolean;
  onClose: () => void;
  transaction?: Transaction;
  mode: 'create' | 'edit';
  defaultHoldingId?: string;
}

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
  const priceId = useId();
  const feeId = useId();
  const descriptionId = useId();
  const referenceId = useId();
  const timestampId = useId();

  // Fetch data
  const { data: holdings, isLoading: holdingsLoading } = trpc.holdings.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getById.useQuery({
    id: 'test-user-1', // Replace with actual user ID from auth context
  });

  const utils = trpc.useUtils();

  // Create maps for quick lookups
  const accountsMap = accounts ? Object.fromEntries(accounts.map((a) => [a.id, a])) : {};
  const tokensMap = tokens ? Object.fromEntries(tokens.map((t) => [t.id, t])) : {};
  const institutionsMap = institutions
    ? Object.fromEntries(institutions.map((i) => [i.id, i]))
    : {};

  // Process holdings with account/token info for display
  const processedHoldings =
    holdings?.map((holding) => {
      const account = accountsMap[holding.accountId];
      const token = tokensMap[holding.tokenId];
      const institution = account ? institutionsMap[account.institutionId] : null;

      return {
        ...holding,
        account,
        token,
        institution,
        displayName: `${token?.name || 'Unknown Token'} in ${account?.name || 'Unknown Account'}`,
        balanceDisplay: `${holding.balance.toFixed(token?.decimals || 2)} ${token?.symbol || ''}`,
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
  } = useForm({
    resolver: zodResolver(TransactionFormSchema),
    defaultValues: {
      holdingId: transaction?.holdingId || defaultHoldingId || '',
      type: (transaction?.type as TransactionFormData['type']) || 'deposit',
      amount: transaction?.amount || 0,
      price: transaction?.price || undefined,
      fee: transaction?.fee || 0,
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
  const watchedPrice = watch('price');
  const watchedFee = watch('fee');

  // Get transaction type info
  const selectedTransactionType = TRANSACTION_TYPES.find((t) => t.value === watchedType);
  const selectedHolding = processedHoldings.find((h) => h.id === watchedHoldingId);

  // Calculate total value for buy/sell transactions
  const totalValue = React.useMemo(() => {
    if (selectedTransactionType?.requiresPrice && watchedPrice && watchedAmount) {
      const baseAmount = FinancialMath.multiply(Math.abs(watchedAmount), watchedPrice);
      const feeAmount = watchedFee || 0;
      return FinancialMath.add(baseAmount, feeAmount);
    }
    return null;
  }, [selectedTransactionType, watchedPrice, watchedAmount, watchedFee]);

  // Reset form when transaction changes
  useEffect(() => {
    if (transaction) {
      reset({
        holdingId: transaction.holdingId,
        type: transaction.type as TransactionFormData['type'],
        amount: transaction.amount,
        price: transaction.price || undefined,
        fee: transaction.fee || 0,
        description: transaction.description || '',
        reference: transaction.reference || '',
        timestamp: new Date(transaction.timestamp),
      });
    } else {
      reset({
        holdingId: defaultHoldingId || '',
        type: 'deposit',
        amount: 0,
        price: undefined,
        fee: 0,
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
    setIsSubmitting(true);
    setHasUnsavedChanges(false);

    const submitData = {
      holdingId: data.holdingId,
      type: data.type,
      amount: data.amount,
      price: data.price,
      fee: data.fee || 0,
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
              <span className="text-2xl">{selectedTransactionType.icon}</span>
            )}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Record a new transaction to track your financial activity'
              : 'Update the details of your transaction'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
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
                {TRANSACTION_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    <div className="flex items-center space-x-2">
                      <span>{type.icon}</span>
                      <div>
                        <div className="font-medium">{type.label}</div>
                        <div className="text-xs text-muted-foreground">{type.description}</div>
                      </div>
                    </div>
                  </SelectItem>
                ))}
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
                  processedHoldings.map((holding) => (
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

            {/* Price (conditional) */}
            {selectedTransactionType?.requiresPrice && (
              <div className="space-y-2">
                <Label htmlFor={priceId}>
                  Price per Unit <span className="text-destructive">*</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    ({userPrefs?.baseCurrency || 'USD'})
                  </span>
                </Label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id={priceId}
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="1000000"
                    {...register('price', {
                      setValueAs: (value) => {
                        if (value === '' || (typeof value === 'string' && value.trim() === '')) {
                          return undefined;
                        }
                        const num = Number(value);
                        return Number.isNaN(num) ? undefined : num;
                      },
                    })}
                    placeholder="0.00"
                    className={`pl-10 ${
                      errors.price ? 'border-destructive focus:ring-destructive' : ''
                    }`}
                    disabled={isSubmitting}
                  />
                </div>
                {errors.price && <p className="text-sm text-destructive">{errors.price.message}</p>}
                <p className="text-xs text-muted-foreground">
                  Price per unit in your base currency
                </p>
              </div>
            )}
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
              <AlertTitle>Total Transaction Value</AlertTitle>
              <AlertDescription>
                <div className="space-y-1">
                  <div>
                    Base:{' '}
                    {FinancialMath.formatCurrency(
                      FinancialMath.multiply(Math.abs(watchedAmount), watchedPrice || 0),
                      { currency: userPrefs?.baseCurrency }
                    )}
                  </div>
                  {watchedFee && watchedFee > 0 && (
                    <div>
                      Fee:{' '}
                      {FinancialMath.formatCurrency(watchedFee, {
                        currency: userPrefs?.baseCurrency,
                      })}
                    </div>
                  )}
                  <div className="font-semibold">
                    Total:{' '}
                    {FinancialMath.formatCurrency(totalValue, {
                      currency: userPrefs?.baseCurrency,
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
