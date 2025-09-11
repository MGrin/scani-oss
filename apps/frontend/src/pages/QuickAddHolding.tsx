import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  AccountSelector,
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
  TokenSelector,
  TokenTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

// Schema for the form
const QuickAddHoldingSchema = z
  .object({
    // Holding fields
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
    averageCostBasis: z
      .number({
        invalid_type_error: 'Average cost basis must be a valid number',
      })
      .min(0, 'Average cost basis cannot be negative')
      .max(1_000_000_000, 'Average cost basis is too large')
      .optional(),

    // Account selection
    accountId: z.string().min(1, 'Please select an account'),

    // New account fields (when accountId is 'new')
    newAccountName: z.string().optional(),
    newAccountType: z.string().optional(),
    newAccountDescription: z.string().optional(),
    newAccountNumber: z.string().optional(),

    // Institution selection (when creating new account)
    institutionId: z.string().optional(),

    // New institution fields (when institutionId is 'new')
    newInstitutionName: z.string().optional(),
    newInstitutionType: z.string().optional(),
    newInstitutionDescription: z.string().optional(),
    newInstitutionWebsite: z.string().optional(),

    // Token selection
    tokenId: z.string().min(1, 'Please select a token'),

    // New token fields (when tokenId is 'new')
    newTokenSymbol: z.string().optional(),
    newTokenName: z.string().optional(),
    newTokenType: z.string().optional(),
    newTokenDecimals: z.number().int().min(0).max(18).optional(),
  })
  .refine(
    (data) => {
      // Validate new account fields
      if (data.accountId === 'new') {
        if (!data.newAccountName || !data.newAccountType || !data.institutionId) {
          return false;
        }
        // Validate new institution fields
        if (
          data.institutionId === 'new' &&
          (!data.newInstitutionName || !data.newInstitutionType)
        ) {
          return false;
        }
      }

      // Validate new token fields
      if (
        data.tokenId === 'new' &&
        (!data.newTokenSymbol || !data.newTokenName || !data.newTokenType)
      ) {
        return false;
      }

      return true;
    },
    {
      message: 'Please complete all required fields',
      path: ['root'],
    }
  );

type QuickAddHoldingData = z.infer<typeof QuickAddHoldingSchema>;

export function QuickAddHolding() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form IDs
  const balanceId = useId();
  const avgCostId = useId();
  const accountSelectId = useId();
  const tokenSelectId = useId();
  const institutionSelectId = useId();

  // Data queries
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: accounts, isLoading: accountsLoading } = trpc.accounts.getAll.useQuery();
  const { data: institutions, isLoading: institutionsLoading } =
    trpc.institutions.getAll.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery();
  const { data: accountTypes, isLoading: accountTypesLoading } =
    trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes, isLoading: institutionTypesLoading } =
    trpc.institutionTypes.getAll.useQuery();
  const { data: tokenTypes, isLoading: tokenTypesLoading } = trpc.tokenTypes.getAll.useQuery();

  const utils = trpc.useUtils();

  // Mutations
  const createInstitution = trpc.institutions.create.useMutation();
  const createAccount = trpc.accounts.create.useMutation();
  const createToken = trpc.tokens.create.useMutation();
  const createHolding = trpc.holdings.create.useMutation();

  const form = useForm<QuickAddHoldingData>({
    resolver: zodResolver(QuickAddHoldingSchema),
    defaultValues: {
      newTokenDecimals: 2,
    },
  });

  const watchAccountId = form.watch('accountId');
  const watchInstitutionId = form.watch('institutionId');
  const watchTokenId = form.watch('tokenId');

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

  useEffect(() => {
    if (!tokensLoading && tokens !== undefined) {
      if (!watchTokenId) {
        if (tokens && tokens.length > 0) {
          // Try to find a token that matches the user's base currency
          let defaultToken = null;

          if (userPrefs?.baseCurrency) {
            // Look for a token with symbol matching the base currency
            defaultToken = tokens.find(
              (token) => token.symbol?.toUpperCase() === userPrefs.baseCurrency.toUpperCase()
            );
          }

          // If no matching token found, fall back to the first token
          if (!defaultToken) {
            defaultToken = tokens[0];
          }

          form.setValue('tokenId', defaultToken?.id || 'new');
        } else {
          // No tokens exist, default to "new"
          form.setValue('tokenId', 'new');
        }
      }
    }
  }, [tokens, tokensLoading, form, watchTokenId, userPrefs?.baseCurrency]);

  const onSubmit = async (data: QuickAddHoldingData) => {
    setIsSubmitting(true);
    try {
      let accountId = data.accountId;
      let tokenId = data.tokenId;

      // Step 1: Create institution if needed
      let institutionId = data.institutionId;
      if (data.accountId === 'new' && data.institutionId === 'new') {
        const newInstitution = await createInstitution.mutateAsync({
          name: data.newInstitutionName!,
          type: data.newInstitutionType!,
          description: data.newInstitutionDescription || '',
          website: data.newInstitutionWebsite || '',
        });
        institutionId = newInstitution?.id;
      }

      // Step 2: Create account if needed
      if (data.accountId === 'new') {
        const newAccount = await createAccount.mutateAsync({
          name: data.newAccountName!,
          type: data.newAccountType!,
          institutionId: institutionId!,
          description: data.newAccountDescription || '',
          accountNumber: data.newAccountNumber || '',
        });
        accountId = newAccount?.id || '';
      }

      // Step 3: Create token if needed
      if (data.tokenId === 'new') {
        // Find the token type ID
        const tokenType = tokenTypes?.find((t) => t.code === data.newTokenType);
        if (!tokenType) {
          throw new Error('Selected token type not found');
        }

        const newToken = await createToken.mutateAsync({
          symbol: data.newTokenSymbol!.toUpperCase(),
          name: data.newTokenName!,
          typeId: tokenType.id,
          decimals: data.newTokenDecimals || 2,
        });
        tokenId = newToken?.id || '';
      }

      // Step 4: Create holding
      if (!accountId || !tokenId || accountId === 'new' || tokenId === 'new') {
        throw new Error('Missing required account or token ID');
      }

      await createHolding.mutateAsync({
        accountId,
        tokenId,
        balance: data.balance,
        averageCostBasis: data.averageCostBasis,
      });

      toast({
        title: 'Success',
        description: 'Holding created successfully!',
        variant: 'success',
      });

      // Invalidate relevant queries
      utils.holdings.getAll.invalidate();
      utils.accounts.getAll.invalidate();
      utils.institutions.getAll.invalidate();
      utils.tokens.getAll.invalidate();

      navigate('/holdings');
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create holding',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLoading =
    accountsLoading ||
    institutionsLoading ||
    tokensLoading ||
    accountTypesLoading ||
    institutionTypesLoading ||
    tokenTypesLoading;

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

            <div className="space-y-1.5">
              <Label htmlFor={avgCostId}>Average Cost Basis</Label>
              <Input
                id={avgCostId}
                type="number"
                step="any"
                placeholder="e.g., 50.25"
                {...form.register('averageCostBasis', {
                  valueAsNumber: true,
                })}
                className={form.formState.errors.averageCostBasis ? 'border-red-500' : ''}
              />
              {form.formState.errors.averageCostBasis && (
                <p className="text-sm text-red-500">
                  {form.formState.errors.averageCostBasis.message}
                </p>
              )}
            </div>
          </div>

          {/* Token Selection within Holding Details */}
          <div className="space-y-4 border-t pt-4">
            <h3 className="text-md font-medium">Token/Asset</h3>

            <div className="space-y-2">
              <Label htmlFor={tokenSelectId}>Select Token *</Label>
              <TokenSelector
                id={tokenSelectId}
                value={form.watch('tokenId') || ''}
                onValueChange={(value) => form.setValue('tokenId', value)}
                tokens={tokens}
                placeholder="Choose a token..."
              />
              {form.formState.errors.tokenId && (
                <p className="text-sm text-red-500">{form.formState.errors.tokenId.message}</p>
              )}
            </div>

            {watchTokenId === 'new' && (
              <div className="space-y-4 border-t pt-4">
                <h4 className="text-sm font-medium">New Token Details</h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Symbol *</Label>
                    <Input
                      placeholder="e.g., AAPL"
                      maxLength={10}
                      {...form.register('newTokenSymbol')}
                      onChange={(e) => {
                        e.target.value = e.target.value.toUpperCase();
                        form.setValue('newTokenSymbol', e.target.value);
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Name *</Label>
                    <Input placeholder="e.g., Apple Inc." {...form.register('newTokenName')} />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Token Type *</Label>
                    <TokenTypeSelector
                      value={form.watch('newTokenType') || ''}
                      onValueChange={(value) => form.setValue('newTokenType', value)}
                      tokenTypes={tokenTypes}
                      placeholder="Choose token type..."
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Decimals</Label>
                    <Input
                      type="number"
                      min="0"
                      max="18"
                      placeholder="2"
                      {...form.register('newTokenDecimals', {
                        valueAsNumber: true,
                      })}
                    />
                  </div>
                </div>
              </div>
            )}
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Account Number</Label>
                    <Input placeholder="e.g., ****1234" {...form.register('newAccountNumber')} />
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
            disabled={isSubmitting || !form.formState.isValid}
            className="min-w-[140px]"
          >
            {isSubmitting && <LoadingSpinner className="mr-2 h-4 w-4" />}
            {isSubmitting ? 'Creating...' : 'Create Holding'}
          </Button>
        </div>
      </form>
    </div>
  );
}
