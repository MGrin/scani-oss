import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AccountSelectionStep } from '@/components/add-data/AccountSelectionStep';
import { DataEntryStep } from '@/components/add-data/DataEntryStep';
import { MethodSelectionStep } from '@/components/add-data/MethodSelectionStep';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { isExternalTokenValue, parseExternalTokenValue } from '@/lib/external-token';
import { trpc } from '@/lib/trpc';
import type { CompleteImportData, Step } from '@/types/addData';

export function AddData() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState<Step>('method');
  const [navContainer, setNavContainer] = useState<Element | null>(null);
  const [isAccountStepValid, setIsAccountStepValid] = useState(false);
  const [accountDisplayText, setAccountDisplayText] = useState<string>('Choose Account');
  const [hasDataChanges, setHasDataChanges] = useState(false);

  const createTokensFromExternalMutation = trpc.tokens.createManyfromExternal.useMutation();

  const createTokenFromExternalMutation = trpc.tokens.createFromExternal.useMutation();
  const createHoldingsWithDependenciesMutation =
    trpc.batchOperations.createHoldingsWithDependencies.useMutation();
  const updateHoldingsBatchMutation = trpc.batchOperations.updateHoldingsBatch.useMutation();
  const updateHoldingMutation = trpc.holdings.update.useMutation({
    onSuccess: () => {
      // Invalidate all related queries using utility function
    },
  });
  const [completeImportData, setCompleteImportData] = useState<CompleteImportData>({});

  const selectedAccountId = completeImportData.accountSelection?.selectedAccountId;

  useEffect(() => {
    const container = document.getElementById('mobile-bottom-nav');
    setNavContainer(container);
  }, []);

  // Load form data from URL params on mount
  useEffect(() => {
    const method = searchParams.get('method') as CompleteImportData['method'];
    const accountId = searchParams.get('accountId');

    if (method) {
      setCompleteImportData((prev) => ({ ...prev, method }));
      setCurrentStep('account');
    }

    if (accountId) {
      setCompleteImportData((prev) => ({
        ...prev,
        accountSelection: { mode: 'select', selectedAccountId: accountId },
      }));
      setCurrentStep('data');
    }
  }, [searchParams]);

  // Update URL params when form data changes
  const updateCompleteImportData = useCallback((updates: Partial<CompleteImportData>) => {
    setCompleteImportData((prev) => ({ ...prev, ...updates }));
  }, []);

  // Sync URL params with complete import data
  useEffect(() => {
    const params = new URLSearchParams();
    if (completeImportData.method) params.set('method', completeImportData.method);
    if (completeImportData.accountSelection?.selectedAccountId)
      params.set('accountId', completeImportData.accountSelection.selectedAccountId);

    setSearchParams(params);
  }, [
    completeImportData.method,
    completeImportData.accountSelection?.selectedAccountId,
    setSearchParams,
  ]);

  // Fetch data needed for progress bar display
  // Note: Account and institution data is handled by AccountSelectionStep

  const nextStep = useCallback(() => {
    if (currentStep === 'method') setCurrentStep('account');
    else if (currentStep === 'account') setCurrentStep('data');
  }, [currentStep]);

  const prevStep = useCallback(() => {
    if (currentStep === 'data') {
      // Going back from data entry to account selection
      // Clear account selection from complete import data and URL
      setCompleteImportData((prev) => {
        const newData = { ...prev };
        delete newData.accountSelection;
        return newData;
      });

      setCurrentStep('account');
    } else if (currentStep === 'account') {
      // Going back from account selection to method selection
      // Clear method and account selection from complete import data and URL
      setCompleteImportData({});
      setCurrentStep('method');
    }
  }, [currentStep]);
  const getStepNumber = (step: Step): number => {
    switch (step) {
      case 'method':
        return 1;
      case 'account':
        return 2;
      case 'data':
        return 3;
    }
  };

  const getProgress = (): number => {
    return (getStepNumber(currentStep) / 3) * 100;
  };

  // Helper to validate if a holding is valid
  const isHoldingValid = (holding: { tokenValue: string; amount: string }): boolean => {
    // Token must be selected
    if (!holding.tokenValue.trim()) return false;

    // Amount must be a valid positive number
    const amount = holding.amount.trim();
    if (!amount) return false;

    const numAmount = Number.parseFloat(amount);
    if (Number.isNaN(numAmount) || numAmount <= 0) return false;

    return true;
  };

  // Calculate valid holdings for button state and text
  const getValidHoldingsInfo = () => {
    const holdings = completeImportData.dataEntry?.holdings || [];
    const validHoldings = holdings.filter(isHoldingValid);
    const hasInvalidHoldings = holdings.some((holding) => !isHoldingValid(holding));

    // For existing accounts, also check if there are changes to existing holdings
    const hasExistingChanges =
      selectedAccountId && completeImportData.accountSelection?.mode === 'select'
        ? holdings.some(
            (h) =>
              h.isExisting &&
              h.amount !== h.originalAmount &&
              h.amount.trim() !== '' &&
              isHoldingValid(h)
          )
        : false;

    return {
      count: validHoldings.length,
      hasInvalid: hasInvalidHoldings || holdings.length === 0,
      hasChanges: hasDataChanges || hasExistingChanges,
    };
  };

  // Helper functions for progress bar display text
  const getMethodDisplayText = (): string => {
    if (!completeImportData.method) return 'Select Method';

    const methods = [
      { id: 'manual', title: 'Manual Entry' },
      { id: 'screenshots', title: 'Screenshots Upload' },
      { id: 'wallet', title: 'Cryptocurrency Wallet' },
    ];

    const selectedMethod = methods.find((m) => m.id === completeImportData.method);
    return selectedMethod ? selectedMethod.title : 'Select Method';
  };

  const getAccountDisplayText = (): string => {
    return accountDisplayText;
  };

  const handleAccountDisplayChange = useCallback((displayText: string) => {
    setAccountDisplayText(displayText);
  }, []);

  const completeWithNewAccount = useCallback(async () => {
    const accountSelection = completeImportData.accountSelection;

    if (!accountSelection || accountSelection.mode !== 'create') {
      console.error('Account selection is not set to create mode');
      return;
    }

    const holdings = completeImportData.dataEntry?.holdings || [];

    const newAccountData = accountSelection.newAccountData;
    if (!newAccountData) {
      console.error('No new account data provided');
      return;
    }

    const newHoldingsToCreate = holdings.filter(
      (h) => !h.isExisting && h.tokenValue.trim() && h.amount.trim()
    );

    if (newHoldingsToCreate.length === 0) {
      console.error('No holdings to create');
      return;
    }

    // Process all holdings - convert external tokens first
    const externalTokensToCreate = newHoldingsToCreate
      .filter((holding) => isExternalTokenValue(holding.tokenValue))
      .map((holding) => {
        const externalTokenData = parseExternalTokenValue(holding.tokenValue);
        if (!externalTokenData) return null;

        return {
          externalId: holding.tokenValue,
          symbol: externalTokenData.symbol,
          provider:
            externalTokenData.provider === 'coingecko'
              ? ('coingecko' as const)
              : ('finnhub' as const),
          metadata: {
            ...externalTokenData.metadata,
            name: externalTokenData.name,
          },
        };
      })
      .filter((token): token is NonNullable<typeof token> => token !== null);

    // Create all external tokens in batch if any exist
    let createdTokensMap: Record<string, string> = {};
    if (externalTokensToCreate.length > 0) {
      const createdTokens =
        await createTokensFromExternalMutation.mutateAsync(externalTokensToCreate);

      // Map external token values to created token IDs
      createdTokensMap = createdTokens.reduce(
        (acc, token) => {
          const externalValue = newHoldingsToCreate.find((h) => {
            const data = parseExternalTokenValue(h.tokenValue);
            return data?.symbol === token.symbol;
          })?.tokenValue;
          if (externalValue) {
            acc[externalValue] = token.id;
          }
          return acc;
        },
        {} as Record<string, string>
      );
    }

    // Build processed holdings with created token IDs
    const processedHoldings = newHoldingsToCreate.map((holding) => ({
      tokenId: createdTokensMap[holding.tokenValue] || holding.tokenValue,
      balance: holding.amount,
    }));

    // Use unified batch operation to create institution (if needed), account, and ALL holdings atomically
    const result = await createHoldingsWithDependenciesMutation.mutateAsync({
      institution:
        newAccountData.institutionSelection?.mode === 'create'
          ? {
              name: newAccountData.institutionSelection.newInstitutionData?.name || '',
              typeId: newAccountData.institutionSelection.newInstitutionData?.typeId || '',
              description: newAccountData.institutionSelection.newInstitutionData?.description,
              website: newAccountData.institutionSelection.newInstitutionData?.website,
            }
          : undefined,
      account: {
        institutionId: newAccountData.institutionSelection?.selectedInstitutionId || undefined,
        name: newAccountData.name,
        typeId: newAccountData.typeId,
      },
      holdings: processedHoldings,
    });

    console.log('Successfully created account and holdings');
    navigate(`/accounts/${result.accountId}`);
    return;
  }, [
    completeImportData.accountSelection,
    completeImportData.dataEntry?.holdings,
    createHoldingsWithDependenciesMutation.mutateAsync,
    navigate,
    createTokensFromExternalMutation.mutateAsync,
  ]);

  const completeWithExistingAccount = useCallback(async () => {
    const accountSelection = completeImportData.accountSelection;

    const accountId = accountSelection?.selectedAccountId;
    if (!accountId) {
      console.error('No account selected');
      return;
    }
    const holdings = completeImportData.dataEntry?.holdings || [];

    // Separate existing holdings that have changed from new holdings
    const existingHoldingsToUpdate = holdings.filter(
      (h) => h.isExisting && h.amount !== h.originalAmount && h.amount.trim() !== ''
    );
    const newHoldingsToCreate = holdings.filter(
      (h) => !h.isExisting && h.tokenValue.trim() && h.amount.trim()
    );

    // Update existing holdings in batch
    if (existingHoldingsToUpdate.length > 0) {
      const holdingsToUpdate = existingHoldingsToUpdate.map((holding) => ({
        // For screenshot uploads: use holdingId
        // For manual entry: use id directly (it's already the holding ID)
        id: holding.holdingId || holding.id,
        balance: holding.amount,
      }));

      await updateHoldingsBatchMutation.mutateAsync({
        holdings: holdingsToUpdate,
      });
    }

    // Create new holdings if any
    if (newHoldingsToCreate.length > 0) {
      // Process all holdings - convert external tokens first
      const externalTokensToCreate = newHoldingsToCreate
        .filter((holding) => isExternalTokenValue(holding.tokenValue))
        .map((holding) => {
          const externalTokenData = parseExternalTokenValue(holding.tokenValue);
          if (!externalTokenData) return null;

          return {
            externalId: holding.tokenValue,
            symbol: externalTokenData.symbol,
            provider:
              externalTokenData.provider === 'coingecko'
                ? ('coingecko' as const)
                : ('finnhub' as const),
            metadata: {
              ...externalTokenData.metadata,
              name: externalTokenData.name,
            },
          };
        })
        .filter((token): token is NonNullable<typeof token> => token !== null);

      // Create all external tokens in batch if any exist
      let createdTokensMap: Record<string, string> = {};
      if (externalTokensToCreate.length > 0) {
        const createdTokens =
          await createTokensFromExternalMutation.mutateAsync(externalTokensToCreate);

        // Map external token values to created token IDs
        createdTokensMap = createdTokens.reduce(
          (acc, token) => {
            const externalValue = newHoldingsToCreate.find((h) => {
              const data = parseExternalTokenValue(h.tokenValue);
              return data?.symbol === token.symbol;
            })?.tokenValue;
            if (externalValue) {
              acc[externalValue] = token.id;
            }
            return acc;
          },
          {} as Record<string, string>
        );
      }

      // Build processed holdings with created token IDs
      const processedHoldings = newHoldingsToCreate.map((holding) => ({
        tokenId: createdTokensMap[holding.tokenValue] || holding.tokenValue,
        balance: holding.amount,
      }));

      // Create all new holdings in batch (account already exists)
      await createHoldingsWithDependenciesMutation.mutateAsync({
        accountId,
        holdings: processedHoldings,
      });
    }
  }, [
    completeImportData.accountSelection,
    completeImportData.dataEntry?.holdings,
    createHoldingsWithDependenciesMutation.mutateAsync,
    updateHoldingsBatchMutation.mutateAsync,
    createTokensFromExternalMutation.mutateAsync,
  ]);

  const complete = useCallback(async () => {
    // Handle completion - create account with holdings or update existing
    const accountSelection = completeImportData.accountSelection;
    const accountId = accountSelection?.selectedAccountId;

    try {
      // Case 1: Creating a new account with holdings
      if (accountSelection?.mode === 'create') {
        await completeWithNewAccount();
        return;
      }

      // Case 2: Using existing account - update existing holdings and/or create new ones
      await completeWithExistingAccount();
      console.log('Successfully updated and created holdings');

      // Redirect to account details page
      navigate(`/accounts/${accountId}`);
    } catch (error) {
      console.error('Failed to update/create holdings:', error);
    }
  }, [
    completeWithNewAccount,
    completeWithExistingAccount,
    navigate,
    completeImportData.accountSelection,
  ]);

  return (
    <div className="space-y-6 pb-16 relative max-w-[calc(100vw-2rem)] md:max-w-3xl lg:max-w-4xl xl:max-w-5xl mx-auto">
      {/* Full screen loading overlay */}
      {(createTokenFromExternalMutation.isPending ||
        createHoldingsWithDependenciesMutation.isPending ||
        updateHoldingsBatchMutation.isPending ||
        updateHoldingMutation.isPending) && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2"></div>
            <p className="text-sm font-medium">Updating holdings...</p>
          </div>
        </div>
      )}

      <PageHeader title="Add Data" subtitle="Import your financial data into Scani" />

      {/* Progress Indicator - Sticky on mobile */}
      <Card className="md:static sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <CardContent className="pt-3 pb-3 md:pt-6 md:pb-6">
          <div className="space-y-2 md:space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base md:text-lg font-semibold">
                Step {getStepNumber(currentStep)} of 3
              </h2>
              <Badge variant="outline" className="text-xs">
                {Math.round(getProgress())}% Complete
              </Badge>
            </div>
            <Progress value={getProgress()} className="w-full h-1 md:h-2" />

            <div className="hidden md:flex justify-between text-sm text-muted-foreground">
              <span className={currentStep === 'method' ? 'font-medium text-foreground' : ''}>
                1. {getMethodDisplayText()}
              </span>
              <span className={currentStep === 'account' ? 'font-medium text-foreground' : ''}>
                2. {getAccountDisplayText()}
              </span>
              <span className={currentStep === 'data' ? 'font-medium text-foreground' : ''}>
                3. Enter Data
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Step Content */}
      {currentStep === 'method' && (
        <MethodSelectionStep
          completeImportData={completeImportData}
          onCompleteDataUpdate={updateCompleteImportData}
        />
      )}
      {currentStep === 'account' && (
        <AccountSelectionStep
          onValidationChange={setIsAccountStepValid}
          onAccountDisplayChange={handleAccountDisplayChange}
          onCompleteDataUpdate={updateCompleteImportData}
        />
      )}
      {currentStep === 'data' && (
        <DataEntryStep
          completeImportData={completeImportData}
          onCompleteDataUpdate={updateCompleteImportData}
          isCreatingHoldings={
            createTokenFromExternalMutation.isPending ||
            createHoldingsWithDependenciesMutation.isPending ||
            updateHoldingsBatchMutation.isPending ||
            updateHoldingMutation.isPending
          }
          onChangesDetected={setHasDataChanges}
        />
      )}

      {/* Bottom Navigation - Rendered via Portal */}
      {navContainer &&
        createPortal(
          <div
            className="fixed bottom-0 left-0 right-0 md:left-64 bg-background border-t p-4"
            style={{
              paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
          >
            <div className="flex justify-between max-w-screen-sm mx-auto">
              <Button variant="outline" onClick={prevStep} disabled={currentStep === 'method'}>
                Back
              </Button>
              <Button
                onClick={async () => {
                  if (currentStep === 'method' && completeImportData.method) {
                    nextStep();
                  } else if (currentStep === 'account') {
                    // For account step, we can always proceed since account selection is optional
                    nextStep();
                  } else if (currentStep === 'data') {
                    await complete();
                  }
                }}
                disabled={
                  (currentStep === 'method' && !completeImportData.method) ||
                  (currentStep === 'account' && !isAccountStepValid) ||
                  (currentStep === 'data' &&
                    (!getValidHoldingsInfo().hasChanges || getValidHoldingsInfo().hasInvalid)) ||
                  createTokenFromExternalMutation.isPending ||
                  createHoldingsWithDependenciesMutation.isPending ||
                  updateHoldingsBatchMutation.isPending ||
                  updateHoldingMutation.isPending
                }
              >
                {currentStep === 'data' ? 'Submit' : 'Continue'}
              </Button>
            </div>
          </div>,
          navContainer
        )}
    </div>
  );
}
