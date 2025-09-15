import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { AsyncTokenSelector } from '@/components/AsyncTokenSelector';
import {
  AccountSelector,
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { TokenForm } from '@/components/TokenForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

// Schema for the form with improved validation
const QuickAddHoldingSchema = z
  .object({
    // Holding fields - Keep as number in frontend, convert to string for backend
    balance: z
      .number({
        required_error: 'Balance is required',
        invalid_type_error: 'Balance must be a valid number',
      })
      .refine((val) => !Number.isNaN(val), 'Balance must be a valid number')
      .refine((val) => val !== 0, 'Balance cannot be zero. Enter the actual holding amount.')
      .refine((val) => Math.abs(val) >= 0.000001, 'Balance is too small. Minimum value is 0.000001')
      .refine(
        (val) => Math.abs(val) <= 1_000_000_000,
        'Balance is too large. Maximum value is 1 billion'
      ),

    // Account selection
    accountId: z.string().min(1, 'Please select an account'),

    // New account fields (conditionally required when accountId is 'new')
    newAccountName: z.string().optional(),
    newAccountType: z.string().optional(),
    newAccountDescription: z.string().optional(),

    // Institution selection (conditionally required when creating new account)
    institutionId: z.string().optional(),

    // New institution fields (conditionally required when institutionId is 'new')
    newInstitutionName: z.string().optional(),
    newInstitutionType: z.string().optional(),
    newInstitutionDescription: z.string().optional(),
    newInstitutionWebsite: z.string().optional(),

    // Token selection
    tokenId: z.string().min(1, 'Please select a token'),
  })
  .superRefine((data, ctx) => {
    // Validate new account fields when creating new account
    if (data.accountId === 'new') {
      if (!data.newAccountName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Account name is required when creating a new account',
          path: ['newAccountName'],
        });
      }

      if (!data.newAccountType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Account type is required when creating a new account',
          path: ['newAccountType'],
        });
      }

      if (!data.institutionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Institution is required when creating a new account',
          path: ['institutionId'],
        });
      }

      // Validate new institution fields when creating new institution
      if (data.institutionId === 'new') {
        if (!data.newInstitutionName?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Institution name is required when creating a new institution',
            path: ['newInstitutionName'],
          });
        }

        if (!data.newInstitutionType) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Institution type is required when creating a new institution',
            path: ['newInstitutionType'],
          });
        }
      }
    }
  });

type QuickAddHoldingData = z.infer<typeof QuickAddHoldingSchema>;

export function QuickAddHolding() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTokenFormOpen, setIsTokenFormOpen] = useState(false);

  // Form IDs
  const balanceId = useId();
  const accountSelectId = useId();
  const tokenSelectId = useId();
  const institutionSelectId = useId();

  // Data queries
  const { data: accounts, isLoading: accountsLoading } = trpc.accounts.getAll.useQuery();
  const { data: institutions, isLoading: institutionsLoading } =
    trpc.institutions.getAll.useQuery();

  const { data: accountTypes, isLoading: accountTypesLoading } =
    trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes, isLoading: institutionTypesLoading } =
    trpc.institutionTypes.getAll.useQuery();

  const utils = trpc.useUtils();

  // Mutations
  const createInstitution = trpc.institutions.create.useMutation();
  const createAccount = trpc.accounts.create.useMutation();
  const createTokenFromExternal = trpc.tokens.createFromExternal.useMutation();

  const createHolding = trpc.holdings.create.useMutation();

  const form = useForm<QuickAddHoldingData>({
    resolver: zodResolver(QuickAddHoldingSchema),
    mode: 'onChange', // Validate on change for better UX
    reValidateMode: 'onChange',
    defaultValues: {},
  });

  const watchAccountId = form.watch('accountId');
  const watchInstitutionId = form.watch('institutionId');

  // Watch all form values for reactive validation
  const formValues = form.watch();

  // Custom validation to check if only required fields are filled
  const isFormValidForSubmission = useMemo(() => {
    const errors = form.formState.errors;

    // Check core required fields
    if (!formValues.accountId || errors.accountId) return false;
    if (!formValues.tokenId || errors.tokenId) return false;
    if (formValues.balance === undefined || formValues.balance === null || errors.balance)
      return false;

    // If creating new account, check required account fields
    if (formValues.accountId === 'new') {
      if (!formValues.newAccountName?.trim() || errors.newAccountName) return false;
      if (!formValues.newAccountType || errors.newAccountType) return false;
      if (!formValues.institutionId || errors.institutionId) return false;

      // If creating new institution, check required institution fields
      if (formValues.institutionId === 'new') {
        if (!formValues.newInstitutionName?.trim() || errors.newInstitutionName) return false;
        if (!formValues.newInstitutionType || errors.newInstitutionType) return false;
      }
    }

    return true;
  }, [formValues, form.formState.errors]);

  // Set default values based on available data
  useEffect(() => {
    if (!accountsLoading && accounts !== undefined && !watchAccountId) {
      if (!accounts || accounts.length === 0) {
        form.setValue('accountId', 'new');
      } else {
        // Default to the first available account
        form.setValue('accountId', accounts[0]?.id || 'new');
      }
    }
  }, [accounts, accountsLoading, form, watchAccountId]);

  useEffect(() => {
    if (
      !institutionsLoading &&
      institutions !== undefined &&
      watchAccountId === 'new' &&
      !watchInstitutionId
    ) {
      // Get institutions where the user has accounts
      const userInstitutionIds = new Set(accounts?.map((account) => account.institutionId) || []);
      const userInstitutions =
        institutions?.filter((inst) => userInstitutionIds.has(inst.id)) || [];

      if (userInstitutions.length > 0) {
        // Default to the first institution where the user has accounts
        form.setValue('institutionId', userInstitutions[0]!.id);
      } else if (institutions && institutions.length > 0) {
        // If no user institutions, default to the first available institution
        form.setValue('institutionId', institutions[0]!.id);
      } else {
        // No institutions available, default to "new"
        form.setValue('institutionId', 'new');
      }
    }
  }, [accounts, institutions, institutionsLoading, form, watchInstitutionId, watchAccountId]);

  // Note: Token auto-selection removed - AsyncTokenSelector handles its own defaults

  const onSubmit = async (data: QuickAddHoldingData) => {
    setIsSubmitting(true);

    try {
      let accountId = data.accountId;
      let tokenId = data.tokenId;
      let institutionId = data.institutionId;

      // Handle external token creation if needed
      if (tokenId.startsWith('external:')) {
        try {
          const parts = tokenId.split(':');
          const externalTokenData = JSON.parse(parts.slice(2).join(':'));

          console.log('Creating external token:', externalTokenData);

          const newToken = await createTokenFromExternal.mutateAsync({
            symbol: externalTokenData.symbol,
            provider: externalTokenData.provider,
            metadata: {
              ...externalTokenData.metadata,
              name: externalTokenData.name,
            },
          });

          tokenId = newToken.id;
          console.log('External token created successfully:', tokenId);
        } catch (error) {
          console.error('External token creation failed:', error);
          throw new Error(
            `Failed to create token: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Step 1: Create institution if needed
      if (data.accountId === 'new' && data.institutionId === 'new') {
        try {
          console.log('Creating institution:', {
            name: data.newInstitutionName,
            type: data.newInstitutionType,
            description: data.newInstitutionDescription || '',
            website: data.newInstitutionWebsite || '',
          });

          const newInstitution = await createInstitution.mutateAsync({
            name: data.newInstitutionName!.trim(),
            type: data.newInstitutionType!,
            description: data.newInstitutionDescription?.trim() || '',
            website: data.newInstitutionWebsite?.trim() || '',
          });

          if (!newInstitution?.id) {
            throw new Error('Failed to create institution - no ID returned');
          }

          institutionId = newInstitution.id;
          console.log('Institution created successfully:', institutionId);
        } catch (error) {
          console.error('Institution creation failed:', error);
          throw new Error(
            `Failed to create institution: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }
      }

      // Step 2: Create account if needed
      if (data.accountId === 'new') {
        try {
          if (!institutionId) {
            throw new Error('Institution ID is required to create an account');
          }

          console.log('Creating account:', {
            name: data.newAccountName,
            type: data.newAccountType,
            institutionId: institutionId,
            description: data.newAccountDescription || '',
          });

          const newAccount = await createAccount.mutateAsync({
            name: data.newAccountName!.trim(),
            type: data.newAccountType!,
            institutionId: institutionId,
            description: data.newAccountDescription?.trim() || '',
          });

          if (!newAccount?.id) {
            throw new Error('Failed to create account - no ID returned');
          }

          accountId = newAccount.id;
          console.log('Account created successfully:', accountId);
        } catch (error) {
          console.error('Account creation failed:', error);
          throw new Error(
            `Failed to create account: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Step 3: Create holding
      try {
        if (!accountId || !tokenId || accountId === 'new' || tokenId === 'new') {
          throw new Error(`Missing required IDs - Account: ${accountId}, Token: ${tokenId}`);
        }

        console.log('Creating holding:', {
          accountId,
          tokenId,
          balance: data.balance.toString(),
        });

        await createHolding.mutateAsync({
          accountId,
          tokenId,
          balance: data.balance.toString(),
        });

        console.log('Holding created successfully');

        toast({
          title: '✅ Success!',
          description:
            'Holding created successfully! Your new holding has been added to your portfolio.',
        });

        // Invalidate relevant queries to refresh data
        await Promise.all([
          utils.holdings.getAll.invalidate(),
          utils.accounts.getAll.invalidate(),
          utils.institutions.getAll.invalidate(),
          utils.tokens.getAll.invalidate(),
        ]);

        navigate('/holdings');
      } catch (error) {
        console.error('Holding creation failed:', error);
        throw new Error(
          `Failed to create holding: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    } catch (error) {
      console.error('Overall submission failed:', error);

      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';

      toast({
        title: '❌ Error Creating Holding',
        description: `${errorMessage}. Please check your information and try again.`,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLoading =
    accountsLoading || institutionsLoading || accountTypesLoading || institutionTypesLoading;

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner className="h-8 w-8" />
            <span className="ml-2">Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <PageHeader
        title="Add Holding"
        subtitle="Create a holding and all necessary accounts and institutions in one step."
      />

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Holding Details */}
        <div className="bg-card border rounded-lg p-4 space-y-4">
          <h2 className="text-lg font-semibold">Holding Details</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={tokenSelectId}>Select Token *</Label>
              <AsyncTokenSelector
                id={tokenSelectId}
                value={form.watch('tokenId') || ''}
                onValueChange={(value: string) => {
                  if (value === 'new') {
                    setIsTokenFormOpen(true);
                  } else if (value.startsWith('external:')) {
                    // Store external token data for later creation
                    form.setValue('tokenId', value);
                  } else {
                    form.setValue('tokenId', value);
                  }
                }}
                placeholder="Choose a token..."
              />
              {form.formState.errors.tokenId && (
                <p className="text-sm text-red-500">{form.formState.errors.tokenId.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={balanceId}>Balance *</Label>
              <Input
                id={balanceId}
                type="number"
                step="any"
                placeholder="e.g., 100.50"
                {...form.register('balance', { valueAsNumber: true })}
                className={form.formState.errors.balance ? 'border-red-500' : ''}
              />
              {form.formState.errors.balance && (
                <p className="text-sm text-red-500">{form.formState.errors.balance.message}</p>
              )}
            </div>
          </div>
        </div>

        {/* Account Selection */}
        <div className="bg-card border rounded-lg p-4 space-y-4">
          <h2 className="text-lg font-semibold">Account</h2>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={accountSelectId}>Select Account *</Label>
              <AccountSelector
                id={accountSelectId}
                value={form.watch('accountId') || ''}
                onValueChange={(value) => form.setValue('accountId', value)}
                accounts={accounts}
                placeholder="Choose an account..."
              />
              {form.formState.errors.accountId && (
                <p className="text-sm text-red-500">{form.formState.errors.accountId.message}</p>
              )}
            </div>
          </div>

          {watchAccountId === 'new' && (
            <div className="space-y-4 border-t pt-4">
              {/* Institution Selection - Now First */}
              <div className="space-y-4">
                <h3 className="text-base font-medium">Institution</h3>

                <div className="space-y-2">
                  <Label htmlFor={institutionSelectId}>Select Institution *</Label>
                  <InstitutionSelector
                    id={institutionSelectId}
                    value={form.watch('institutionId') || ''}
                    onValueChange={(value) => form.setValue('institutionId', value)}
                    institutions={institutions}
                    placeholder="Choose an institution..."
                  />
                </div>

                {watchInstitutionId === 'new' && (
                  <div className="space-y-4 border rounded-lg p-4">
                    <h4 className="font-medium">New Institution Details</h4>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Institution Name *</Label>
                        <Input
                          placeholder="e.g., Bank of America"
                          {...form.register('newInstitutionName')}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Institution Type *</Label>
                        <InstitutionTypeSelector
                          value={form.watch('newInstitutionType') || ''}
                          onValueChange={(value) => form.setValue('newInstitutionType', value)}
                          institutionTypes={institutionTypes}
                          placeholder="Choose institution type..."
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Website</Label>
                        <Input
                          placeholder="https://example.com"
                          {...form.register('newInstitutionWebsite')}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Description</Label>
                        <Input
                          placeholder="Optional description"
                          {...form.register('newInstitutionDescription')}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Account Details - Now Second */}
              <div className="space-y-4 border-t pt-4">
                <h3 className="text-base font-medium">New Account Details</h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Account Name *</Label>
                    <Input
                      placeholder="e.g., Primary Checking"
                      {...form.register('newAccountName')}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Account Type *</Label>
                    <AccountTypeSelector
                      value={form.watch('newAccountType') || ''}
                      onValueChange={(value) => form.setValue('newAccountType', value)}
                      accountTypes={accountTypes}
                      placeholder="Choose account type..."
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input
                    placeholder="Optional description"
                    {...form.register('newAccountDescription')}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Submit Actions */}
        <div className="flex justify-between items-center pt-6">
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || !isFormValidForSubmission}
            className="min-w-[140px]"
          >
            {isSubmitting && <LoadingSpinner className="mr-2 h-4 w-4" />}
            {isSubmitting ? 'Creating...' : 'Create Holding'}
          </Button>
        </div>
      </form>

      {/* Token Creation Dialog */}
      <TokenForm
        isOpen={isTokenFormOpen}
        onClose={() => setIsTokenFormOpen(false)}
        mode="create"
        onSuccess={(token) => {
          // Invalidate tokens queries to refresh the AsyncTokenSelector
          utils.tokens.getAll.invalidate();
          utils.tokens.search.invalidate();

          // Set the newly created token ID in the form
          form.setValue('tokenId', token.id);
          toast({
            title: 'Token selected',
            description: `${token.symbol} - ${token.name} has been selected for the holding.`,
          });
        }}
      />
    </div>
  );
}
