import { zodResolver } from '@hookform/resolvers/zod';
import { AccountType } from '@scani/shared';
import React, { useCallback, useId, useState } from 'react';
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
import type { ApiInstitution } from '@/lib/api-types';
import { trpc } from '@/lib/trpc';

const AccountFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Account name is required')
    .max(100, 'Account name must be at most 100 characters')
    .regex(
      /^[a-zA-Z0-9\s\-_.,()&']+$/,
      'Account name contains invalid characters. Only letters, numbers, spaces, and common punctuation are allowed.'
    ),
  type: AccountType,
  institutionId: z.string().min(1, 'Please select an institution'),
  description: z
    .string()
    .max(500, 'Description must be at most 500 characters')
    .optional()
    .or(z.literal('')),
  accountNumber: z
    .string()
    .max(50, 'Account number must be at most 50 characters')
    .regex(
      /^[*\dA-Za-z\-_\s]*$/,
      'Account number format invalid. Use masked format like ****1234 or alphanumeric characters.'
    )
    .optional()
    .or(z.literal('')),
});

type AccountFormData = z.infer<typeof AccountFormSchema>;

interface AccountFormProps {
  isOpen: boolean;
  onClose: () => void;
  account?: {
    id: string;
    name: string;
    type: string;
    institutionId: string;
    description?: string;
    accountNumber?: string;
  };
  mode: 'create' | 'edit';
}

export function AccountForm({ isOpen, onClose, account, mode }: AccountFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);
  const nameId = useId();
  const accountNumberId = useId();
  const descriptionId = useId();
  const institutionId = useId();
  const typeId = useId();

  const { data: institutions, isLoading: institutionsLoading } =
    trpc.institutions.getAll.useQuery();
  const {
    data: accountTypes,
    isLoading: accountTypesLoading,
    error: accountTypesError,
  } = trpc.accountTypes.getAll.useQuery();

  const utils = trpc.useUtils();

  const createAccount = trpc.accounts.create.useMutation({
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: `Account "${data?.name || 'New account'}" has been created successfully.`,
        variant: 'success',
      });
      utils.accounts.getAll.invalidate();
      handleSuccessfulClose();
    },
    onError: (error) => {
      const isNetworkError =
        !navigator.onLine ||
        error?.message?.includes('fetch') ||
        error?.message?.includes('network');

      toast({
        title: isNetworkError ? 'Network Error' : 'Error Creating Account',
        description: isNetworkError
          ? 'Unable to connect to the server. Please check your internet connection.'
          : error.message || 'Failed to create account. Please try again.',
        variant: 'destructive',
        action: isNetworkError ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Retry the creation with current form data
              const formData = watch();
              onSubmit(formData);
            }}
          >
            Retry
          </Button>
        ) : undefined,
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const updateAccount = trpc.accounts.update.useMutation({
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: `Account "${data?.name || 'Account'}" has been updated successfully.`,
        variant: 'success',
      });
      utils.accounts.getAll.invalidate();
      handleSuccessfulClose();
    },
    onError: (error) => {
      const isNetworkError =
        !navigator.onLine ||
        error?.message?.includes('fetch') ||
        error?.message?.includes('network');

      toast({
        title: isNetworkError ? 'Network Error' : 'Error Updating Account',
        description: isNetworkError
          ? 'Unable to connect to the server. Please check your internet connection.'
          : error.message || 'Failed to update account. Please try again.',
        variant: 'destructive',
        action: isNetworkError ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Retry the update with current form data
              const formData = watch();
              onSubmit(formData);
            }}
          >
            Retry
          </Button>
        ) : undefined,
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty, isValid },
    setValue,
    watch,
    reset,
    setError,
    clearErrors,
  } = useForm<AccountFormData>({
    resolver: zodResolver(AccountFormSchema),
    defaultValues: {
      name: account?.name || '',
      type: (account?.type as z.infer<typeof AccountType>) || 'checking',
      institutionId: account?.institutionId || '',
      description: account?.description || '',
      accountNumber: account?.accountNumber || '',
    },
    mode: 'onSubmit',
  });

  // Reset form when account changes
  React.useEffect(() => {
    if (account) {
      reset({
        name: account.name,
        type: account.type as z.infer<typeof AccountType>,
        institutionId: account.institutionId,
        description: account.description || '',
        accountNumber: account.accountNumber || '',
      });
    } else {
      reset({
        name: '',
        type: 'checking',
        institutionId: '',
        description: '',
        accountNumber: '',
      });
    }
  }, [account, reset]);

  const watchedType = watch('type');
  const watchedName = watch('name');
  const watchedDescription = watch('description');
  const watchedAccountNumber = watch('accountNumber');

  // Helper functions
  const handleSuccessfulClose = useCallback(() => {
    reset();
    setShowUnsavedWarning(false);
    onClose();
  }, [reset, onClose]);

  const handleCancelWithWarning = useCallback(() => {
    if (isDirty) {
      setShowUnsavedWarning(true);
    } else {
      handleSuccessfulClose();
    }
  }, [isDirty, handleSuccessfulClose]);

  const confirmUnsavedClose = useCallback(() => {
    setShowUnsavedWarning(false);
    handleSuccessfulClose();
  }, [handleSuccessfulClose]);

  const cancelUnsavedClose = useCallback(() => {
    setShowUnsavedWarning(false);
  }, []);

  const onSubmit = async (data: AccountFormData) => {
    // Check for basic form validation errors
    const hasFormErrors = Object.keys(errors).length > 0;

    if (hasFormErrors) {
      toast({
        title: 'Validation Error',
        description: 'Please fix the errors below and try again.',
        variant: 'destructive',
      });
      return;
    }

    // Prevent submission if account types failed to load
    if (accountTypesError) {
      toast({
        title: 'Error',
        description: 'Account types could not be loaded. Please refresh the page and try again.',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);

    // Check name uniqueness only on submission with retry logic
    let nameCheckRetries = 0;
    const maxRetries = 2;

    while (nameCheckRetries <= maxRetries) {
      try {
        const nameCheckResult = await utils.client.accounts.checkNameUniqueness.query({
          name: data.name.trim(),
          institutionId: data.institutionId,
          excludeId: mode === 'edit' ? account?.id : undefined,
        });

        if (!nameCheckResult.isUnique) {
          setError('name', {
            type: 'manual',
            message: 'An account with this name already exists in this institution.',
          });
          toast({
            title: 'Name Already Exists',
            description:
              'An account with this name already exists in this institution. Please choose a different name.',
            variant: 'destructive',
          });
          setIsSubmitting(false);
          return;
        }

        // If we get here, the uniqueness check was successful
        break;
      } catch (error: unknown) {
        nameCheckRetries++;
        console.warn(`Name uniqueness check failed (attempt ${nameCheckRetries}):`, error);

        // On the last retry attempt, show error and abort
        if (nameCheckRetries > maxRetries) {
          const errorObj = error as { code?: string; message?: string };
          const isNetworkError =
            !navigator.onLine ||
            errorObj.code === 'NETWORK_ERROR' ||
            errorObj.message?.includes('fetch');

          toast({
            title: isNetworkError ? 'Network Error' : 'Validation Error',
            description: isNetworkError
              ? 'Unable to connect to the server. Please check your internet connection and try again.'
              : 'Unable to validate account name. Please try again.',
            variant: 'destructive',
            action: isNetworkError ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Reset retries and try again
                  nameCheckRetries = 0;
                  onSubmit(data);
                }}
              >
                Retry
              </Button>
            ) : undefined,
          });
          setIsSubmitting(false);
          return;
        }

        // Wait before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 2 ** nameCheckRetries * 500));
      }
    }

    const submissionData = {
      name: data.name.trim(),
      type: data.type,
      institutionId: data.institutionId,
      description: data.description?.trim() || undefined,
      accountNumber: data.accountNumber?.trim() || undefined,
    };

    if (mode === 'create') {
      createAccount.mutate(submissionData);
    } else if (account) {
      updateAccount.mutate({
        id: account.id,
        data: submissionData,
      });
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      handleCancelWithWarning();
    }
  };

  const accountTypeOptions =
    accountTypes?.map((type) => ({
      value: type.code,
      label: type.name,
    })) || [];

  // Show error if backend fails to return account types
  if (accountTypesError) {
    console.error('Failed to load account types from backend:', accountTypesError);
  }

  return (
    <>
      {/* Main Form Dialog */}
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? 'Add New Account' : 'Edit Account'}</DialogTitle>
            <DialogDescription>
              {mode === 'create'
                ? 'Create a new financial account to track your holdings and transactions.'
                : 'Update the details of your financial account.'}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {/* Account Name */}
            <div className="space-y-2">
              <Label htmlFor={nameId}>Account Name *</Label>
              <Input
                id={nameId}
                {...register('name')}
                placeholder="e.g., Main Checking, Investment Portfolio"
                maxLength={100}
                disabled={isSubmitting}
                className={errors.name ? 'border-destructive focus:border-destructive' : ''}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? `${nameId}-error` : `${nameId}-help`}
                aria-required="true"
              />
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1 sm:gap-0">
                <div className="flex-1 min-h-[20px]">
                  {errors.name && (
                    <p
                      id={`${nameId}-error`}
                      className="text-sm text-destructive"
                      role="alert"
                      aria-live="polite"
                    >
                      {errors.name.message}
                    </p>
                  )}
                  {!errors.name && watchedName && (
                    <p id={`${nameId}-help`} className="text-xs text-muted-foreground">
                      Choose a unique name within this institution
                    </p>
                  )}
                </div>
                <div className="text-xs text-muted-foreground sm:ml-2 self-end sm:self-auto">
                  <span
                    className={
                      watchedName && watchedName.length > 90 ? 'text-orange-600 font-medium' : ''
                    }
                  >
                    {watchedName?.length || 0}/100
                  </span>
                </div>
              </div>
            </div>

            {/* Institution */}
            <div className="space-y-2">
              <Label htmlFor="institutionId">Institution *</Label>
              <Select
                value={watch('institutionId')}
                onValueChange={(value) => {
                  setValue('institutionId', value);
                  clearErrors('institutionId');
                }}
              >
                <SelectTrigger
                  className={
                    errors.institutionId ? 'border-destructive focus:border-destructive' : ''
                  }
                  aria-invalid={!!errors.institutionId}
                  aria-describedby={errors.institutionId ? `${institutionId}-error` : undefined}
                >
                  <SelectValue placeholder="Select an institution" />
                </SelectTrigger>
                <SelectContent>
                  {institutionsLoading ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      <span className="sr-only">Loading institutions</span>
                      <span aria-hidden="true">Loading institutions...</span>
                    </div>
                  ) : institutions?.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      No institutions found. Please add an institution first.
                    </div>
                  ) : (
                    institutions?.map((institution: ApiInstitution) => (
                      <SelectItem key={institution.id} value={institution.id}>
                        {institution.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {errors.institutionId && (
                <p
                  id={`${institutionId}-error`}
                  className="text-sm text-destructive"
                  role="alert"
                  aria-live="polite"
                >
                  {errors.institutionId.message}
                </p>
              )}
            </div>

            {/* Account Type */}
            <div className="space-y-2">
              <Label htmlFor="type">Account Type *</Label>
              <Select
                value={watchedType}
                onValueChange={(value) => {
                  setValue('type', value as z.infer<typeof AccountType>);
                  clearErrors('type');
                }}
              >
                <SelectTrigger
                  className={errors.type ? 'border-destructive focus:border-destructive' : ''}
                  aria-invalid={!!errors.type}
                  aria-describedby={errors.type ? `${typeId}-error` : undefined}
                >
                  <SelectValue placeholder="Select account type" />
                </SelectTrigger>
                <SelectContent>
                  {accountTypesLoading ? (
                    <SelectItem value="loading" disabled>
                      Loading account types...
                    </SelectItem>
                  ) : accountTypesError ? (
                    <SelectItem value="error" disabled>
                      Error loading account types
                    </SelectItem>
                  ) : (
                    accountTypeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {errors.type && (
                <p
                  id={`${typeId}-error`}
                  className="text-sm text-destructive"
                  role="alert"
                  aria-live="polite"
                >
                  {errors.type.message}
                </p>
              )}
            </div>

            {/* Account Number (Optional) */}
            <div className="space-y-2">
              <Label htmlFor={accountNumberId}>Account Number (Optional)</Label>
              <Input
                id={accountNumberId}
                {...register('accountNumber')}
                placeholder="e.g., ****1234"
                maxLength={50}
                disabled={isSubmitting}
                className={
                  errors.accountNumber ? 'border-destructive focus:border-destructive' : ''
                }
                aria-invalid={!!errors.accountNumber}
                aria-describedby={
                  errors.accountNumber ? `${accountNumberId}-error` : `${accountNumberId}-help`
                }
              />
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1 sm:gap-0">
                <div className="flex-1 min-h-[20px]">
                  {errors.accountNumber && (
                    <p
                      id={`${accountNumberId}-error`}
                      className="text-sm text-destructive"
                      role="alert"
                      aria-live="polite"
                    >
                      {errors.accountNumber.message}
                    </p>
                  )}
                  {!errors.accountNumber && (
                    <p id={`${accountNumberId}-help`} className="text-xs text-muted-foreground">
                      For security, consider masking the account number (e.g., ****1234)
                    </p>
                  )}
                </div>
                {watchedAccountNumber && (
                  <div className="text-xs text-muted-foreground sm:ml-2 self-end sm:self-auto">
                    <span
                      className={
                        watchedAccountNumber && watchedAccountNumber.length > 45
                          ? 'text-orange-600 font-medium'
                          : ''
                      }
                    >
                      {watchedAccountNumber?.length || 0}/50
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Description (Optional) */}
            <div className="space-y-2">
              <Label htmlFor={descriptionId}>Description (Optional)</Label>
              <Textarea
                id={descriptionId}
                {...register('description')}
                placeholder="Additional details about this account..."
                rows={3}
                maxLength={500}
                disabled={isSubmitting}
                className={errors.description ? 'border-destructive focus:border-destructive' : ''}
                aria-invalid={!!errors.description}
                aria-describedby={
                  errors.description ? `${descriptionId}-error` : `${descriptionId}-help`
                }
              />
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1 sm:gap-0">
                <div className="flex-1 min-h-[20px]">
                  {errors.description && (
                    <p
                      id={`${descriptionId}-error`}
                      className="text-sm text-destructive"
                      role="alert"
                      aria-live="polite"
                    >
                      {errors.description.message}
                    </p>
                  )}
                  {!errors.description && watchedDescription && (
                    <p id={`${descriptionId}-help`} className="text-xs text-muted-foreground">
                      Provide additional context or notes about this account
                    </p>
                  )}
                </div>
                <div className="text-xs text-muted-foreground sm:ml-2 self-end sm:self-auto">
                  <span
                    className={
                      watchedDescription && watchedDescription.length > 450
                        ? 'text-orange-600 font-medium'
                        : ''
                    }
                  >
                    {watchedDescription?.length || 0}/500
                  </span>
                </div>
              </div>
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
              <Button type="submit" disabled={isSubmitting || !isValid} className="min-w-[120px]">
                {isSubmitting ? (
                  <div className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
                      aria-hidden="true"
                    />
                    <span>{mode === 'create' ? 'Creating...' : 'Updating...'}</span>
                  </div>
                ) : mode === 'create' ? (
                  'Create Account'
                ) : (
                  'Update Account'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Unsaved Changes Warning Dialog */}
      <Dialog open={showUnsavedWarning} onOpenChange={() => setShowUnsavedWarning(false)}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Are you sure you want to discard them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelUnsavedClose}>
              Continue Editing
            </Button>
            <Button variant="destructive" onClick={confirmUnsavedClose}>
              Discard Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
