import { zodResolver } from '@hookform/resolvers/zod';
import type { TokenProvider } from '@scani/shared';
import { AlertCircle, Camera, Info, PenTool, Plus, Trash2, Wallet } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { AsyncTokenSelector } from '@/components/AsyncTokenSelector';
import { PrivateTokenForm } from '@/components/PrivateTokenForm';
import { ScreenshotUpload } from '@/components/ScreenshotUpload';
import {
  AccountSelector,
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading';
import { PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEntityData } from '@/contexts/EntityDataContext';
import { useToast } from '@/hooks/use-toast';
import { type ParsedHolding, useScreenshotParsing } from '@/hooks/useScreenshotParsing';
import { isExternalTokenValue, parseExternalTokenValue } from '@/lib/external-token';
import { withRetry } from '@/lib/retry';
import { trpc } from '@/lib/trpc';
import { normalizeSymbol } from '@/lib/utils';

type ExistingHoldingOption = {
  id: string;
  tokenId: string;
  balance: string;
  tokenSymbol?: string;
  tokenName?: string;
  lastUpdated?: Date | string;
};

type EditableHoldingState = ParsedHolding & {
  processingAction: 'create' | 'update-existing';
  availableExistingHoldings: ExistingHoldingOption[];
};

// Schema for the form with improved validation
const AddDataSchema = z
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

type AddDataFormData = z.infer<typeof AddDataSchema>;

// Step definitions
type WorkflowStep =
  | 'entry-method'
  | 'account-selection'
  | 'manual-entry'
  | 'screenshot-entry'
  | 'wallet-entry';

export function AddData() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTokenFormOpen, setIsTokenFormOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [isImportingWallet, setIsImportingWallet] = useState(false);
  const walletInputId = useId();

  // Get pre-selected account and method from URL params
  const preSelectedAccountId = searchParams.get('accountId');
  const preSelectedMethod = searchParams.get('method') as 'manual' | 'screenshot' | null;

  // State for manually selected account (when going through account selection step)
  const [selectedAccountId, setSelectedAccountId] = useState<string>(preSelectedAccountId || '');

  // Track the selected entry method when going through account selection
  const [selectedEntryMethod, setSelectedEntryMethod] = useState<'manual' | 'screenshot' | null>(
    preSelectedMethod || null
  );

  // Step management - if method and account are provided, skip to that workflow
  const getInitialStep = (): WorkflowStep => {
    if (preSelectedAccountId && preSelectedMethod) {
      // Skip directly to the entry form
      if (preSelectedMethod === 'manual') {
        return 'manual-entry';
      } else if (preSelectedMethod === 'screenshot') {
        return 'screenshot-entry';
      }
    }
    return 'entry-method';
  };

  const [currentStep, setCurrentStep] = useState<WorkflowStep>(getInitialStep());

  // Track if we should skip account selection (when coming from account page)
  const shouldSkipAccountSelection = Boolean(preSelectedAccountId);

  // Screenshot parsing hook
  const screenshotParsing = useScreenshotParsing({
    allowMultiple: true,
    onSuccess: () => {
      toast({
        title: 'Success!',
        description: 'Holdings have been successfully added to your account.',
      });
      navigate('/holdings');
    },
    onMultipleParsingComplete: (result) => {
      // Handle multiple screenshot results - use combined holdings
      if (result.combinedHoldings) {
        setEditableHoldings(
          result.combinedHoldings.map((holding) => mapParsedHoldingToEditableState(holding))
        );
      }
    },
  });

  const isScreenshotProcessing =
    screenshotParsing.state === 'processing' || screenshotParsing.isFinalizing;
  const isScreenshotBusy = screenshotParsing.isBusy;
  const baseFinalizingMessage = screenshotParsing.finalizingMessage ?? 'Processing holdings...';

  // State for editable holdings from screenshot
  const [editableHoldings, setEditableHoldings] = useState<EditableHoldingState[]>([]);
  const [editingHoldingIds, setEditingHoldingIds] = useState<Set<number>>(new Set());
  // Track token selection for each editable holding by index
  const [editableHoldingTokenIds, setEditableHoldingTokenIds] = useState<Record<number, string>>(
    {}
  );
  // Stable keys for editable holdings to prevent remounts on every keystroke
  const rowKeysRef = useRef<string[]>([]);

  const mapParsedHoldingToEditableState = useCallback(
    (holding: ParsedHolding): EditableHoldingState => ({
      ...holding,
      processingAction: holding.existingHoldingId ? 'update-existing' : 'create',
      availableExistingHoldings: [],
    }),
    []
  );

  // Update editable holdings when parsing results change
  useEffect(() => {
    // Handle both single and multiple screenshot results
    let holdings: ParsedHolding[] = [];

    if (screenshotParsing.multipleResults?.combinedHoldings) {
      holdings = screenshotParsing.multipleResults.combinedHoldings;
    } else if (screenshotParsing.parsingResults?.holdings) {
      holdings = screenshotParsing.parsingResults.holdings;
    }

    if (holdings.length > 0) {
      // Sort holdings: error holdings (requiresUserSelection or errors) first
      const sortedHoldings = [...holdings].sort((a, b) => {
        const aHasErrors = a.requiresUserSelection || a.errors.length > 0;
        const bHasErrors = b.requiresUserSelection || b.errors.length > 0;

        if (aHasErrors && !bHasErrors) return -1;
        if (!aHasErrors && bHasErrors) return 1;
        return 0;
      });

      const enrichedHoldings = sortedHoldings.map((holding) =>
        mapParsedHoldingToEditableState(holding)
      );
      setEditableHoldings(enrichedHoldings);

      // Initialize token selections for holdings that have existing tokens
      const tokenSelections: Record<number, string> = {};
      const editingIds = new Set<number>();

      sortedHoldings.forEach((holding, index) => {
        if (holding.tokenExists && holding.tokenId) {
          tokenSelections[index] = holding.tokenId;
        }

        // Auto-enable edit mode for holdings that require user selection
        if (holding.requiresUserSelection || holding.errors.length > 0) {
          editingIds.add(index);
        }
      });

      setEditableHoldingTokenIds(tokenSelections);
      setEditingHoldingIds(editingIds);
    }
  }, [
    screenshotParsing.parsingResults,
    screenshotParsing.multipleResults,
    mapParsedHoldingToEditableState,
  ]);

  // Ensure we have stable keys for each holding row
  useEffect(() => {
    const needed = editableHoldings.length - rowKeysRef.current.length;
    if (needed > 0) {
      for (let i = 0; i < needed; i++) {
        rowKeysRef.current.push(`eh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
      }
    }
  }, [editableHoldings.length]);

  // Form IDs
  const balanceId = useId();
  const accountSelectId = useId();
  const tokenSelectId = useId();
  const institutionSelectId = useId();

  const {
    accounts: accountsState,
    institutions: institutionsState,
    accountTypes: accountTypesState,
    institutionTypes: institutionTypesState,
    tokens: tokensState,
  } = useEntityData();

  const accounts = accountsState.data;
  const accountsLoading = accountsState.isLoading;
  const institutions = institutionsState.data;
  const institutionsLoading = institutionsState.isLoading;
  const accountTypes = accountTypesState.data;
  const accountTypesLoading = accountTypesState.isLoading;
  const institutionTypes = institutionTypesState.data;
  const institutionTypesLoading = institutionTypesState.isLoading;
  const allTokens = tokensState.data;

  // Get currently selected account (either from URL params or manual selection)
  const currentlySelectedAccountId = preSelectedAccountId || selectedAccountId;
  const currentlySelectedAccount = accounts?.find((acc) => acc.id === currentlySelectedAccountId);

  // Get existing holdings for the selected account to show create/update status
  const { data: allHoldings } = trpc.holdings.getAll.useQuery(undefined, {
    enabled:
      !!currentlySelectedAccountId &&
      (currentStep === 'screenshot-entry' || currentStep === 'manual-entry'),
  });

  // Filter holdings for current account and add token info
  const existingHoldings = useMemo<ExistingHoldingOption[]>(() => {
    if (!allHoldings || !allTokens || !currentlySelectedAccountId) return [];

    return allHoldings
      .filter((holding) => holding.accountId === currentlySelectedAccountId)
      .map((holding) => {
        const token = allTokens.find((t) => t.id === holding.tokenId);
        return {
          id: holding.id,
          tokenId: holding.tokenId,
          balance: holding.balance,
          tokenSymbol: token?.symbol,
          tokenName: token?.name,
          lastUpdated: holding.lastUpdated,
        } satisfies ExistingHoldingOption;
      });
  }, [allHoldings, allTokens, currentlySelectedAccountId]);

  const existingHoldingsById = useMemo(
    () => new Map(existingHoldings.map((holding) => [holding.id, holding])),
    [existingHoldings]
  );

  const existingHoldingsBySymbol = useMemo(() => {
    const map = new Map<string, ExistingHoldingOption[]>();

    existingHoldings.forEach((holding) => {
      if (!holding.tokenSymbol) {
        return;
      }

      const normalized = normalizeSymbol(holding.tokenSymbol);
      const list = map.get(normalized);
      if (list) {
        list.push(holding);
      } else {
        map.set(normalized, [holding]);
      }
    });

    return map;
  }, [existingHoldings]);

  useEffect(() => {
    if (editableHoldings.length === 0) {
      return;
    }

    setEditableHoldings((prev) =>
      prev.map((holding, index) => {
        const selectedTokenId = editableHoldingTokenIds[index] ?? holding.tokenId;
        const normalizedSymbol = holding.symbol ? normalizeSymbol(holding.symbol) : null;

        let nextOptions: ExistingHoldingOption[] = [];

        if (selectedTokenId) {
          nextOptions = existingHoldings.filter(
            (candidate) => candidate.tokenId === selectedTokenId
          );
        }

        if (nextOptions.length === 0 && normalizedSymbol) {
          nextOptions = existingHoldingsBySymbol.get(normalizedSymbol) ?? [];
        }

        const currentOptionIds = holding.availableExistingHoldings.map((option) => option.id);
        const nextOptionIds = nextOptions.map((option) => option.id);
        const optionsChanged =
          currentOptionIds.length !== nextOptionIds.length ||
          currentOptionIds.some((id, idx) => id !== nextOptionIds[idx]);

        let nextProcessingAction = holding.processingAction;
        let nextExistingHoldingId = holding.existingHoldingId;

        if (nextProcessingAction === undefined) {
          nextProcessingAction = holding.existingHoldingId ? 'update-existing' : 'create';
        }

        const hadNoOptionsPreviously = holding.availableExistingHoldings.length === 0;

        if (!nextExistingHoldingId && nextOptions.length === 1 && hadNoOptionsPreviously) {
          nextProcessingAction = 'update-existing';
          nextExistingHoldingId = nextOptions[0]!.id;
        } else if (
          nextExistingHoldingId &&
          !nextOptions.some((option) => option.id === nextExistingHoldingId)
        ) {
          nextExistingHoldingId = undefined;
          nextProcessingAction = 'create';
        } else if (nextExistingHoldingId) {
          nextProcessingAction = 'update-existing';
        }

        if (
          !optionsChanged &&
          nextProcessingAction === holding.processingAction &&
          nextExistingHoldingId === holding.existingHoldingId
        ) {
          return holding;
        }

        return {
          ...holding,
          availableExistingHoldings: nextOptions,
          processingAction: nextProcessingAction,
          existingHoldingId: nextExistingHoldingId,
        };
      })
    );
  }, [
    editableHoldings.length,
    existingHoldings,
    existingHoldingsBySymbol,
    editableHoldingTokenIds,
  ]);

  const utils = trpc.useUtils();

  // Helper to wait for entity to appear in cache after mutation
  const waitForCacheSettlement = async (
    queryKey: 'institutions' | 'accounts' | 'holdings',
    expectedId?: string,
    maxRetries = 30 // Increased from 10 to 30 (3 seconds total)
  ) => {
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      let data: Array<{ id: string }> | undefined;
      switch (queryKey) {
        case 'institutions':
          data = utils.institutions.getAll.getData();
          break;
        case 'accounts':
          data = utils.accounts.getAll.getData();
          break;
        case 'holdings':
          data = utils.holdings.getAll.getData();
          break;
      }

      if (expectedId && data?.some((item) => item.id === expectedId)) {
        console.log(`✅ Cache settled for ${queryKey}:`, expectedId);
        return true;
      }
    }

    throw new Error(`⏱️ Cache settlement timeout for ${queryKey}`);
  };

  // Mutations
  const createInstitution = trpc.institutions.create.useMutation();
  const createAccount = trpc.accounts.create.useMutation();
  const createTokenFromExternal = trpc.tokens.createFromExternal.useMutation();
  const createHolding = trpc.holdings.create.useMutation();
  const importWallet = trpc.wallet.importWalletAddress.useMutation();

  const form = useForm<AddDataFormData>({
    resolver: zodResolver(AddDataSchema),
    mode: 'onChange', // Validate on change for better UX
    reValidateMode: 'onChange',
    defaultValues: {
      accountId: preSelectedAccountId || '',
    },
  });

  // Helper functions for editable holdings
  const updateHolding = (index: number, updates: Partial<EditableHoldingState>) => {
    setEditableHoldings((prev) =>
      prev.map((holding, i) => (i === index ? { ...holding, ...updates } : holding))
    );
  };

  // Synchronize token selections with holdings before processing
  const synchronizeTokenSelections = useCallback((): ParsedHolding[] => {
    const nextHoldings: EditableHoldingState[] = [];
    const sanitizedHoldings: ParsedHolding[] = [];

    editableHoldings.forEach((holding, index) => {
      const selectedTokenId = editableHoldingTokenIds[index];
      let updatedHolding: EditableHoldingState = { ...holding };

      const errorSet = new Set(updatedHolding.errors);

      if (!updatedHolding.symbol || updatedHolding.symbol.trim() === '') {
        errorSet.add('Symbol is required');
      }

      if (
        !updatedHolding.balance ||
        updatedHolding.balance.trim() === '' ||
        parseFloat(updatedHolding.balance) <= 0
      ) {
        errorSet.add('Valid balance amount is required');
      }

      if (selectedTokenId && selectedTokenId !== updatedHolding.tokenId) {
        if (isExternalTokenValue(selectedTokenId)) {
          try {
            const metadata = parseExternalTokenValue(selectedTokenId)!;

            updatedHolding = {
              ...updatedHolding,
              symbol: normalizeSymbol(metadata.symbol),
              name: metadata.name,
              tokenExists: false,
              requiresUserSelection: false,
              providerValidation: {
                exactMatch: {
                  isValid: true,
                  metadata: {
                    ...metadata,
                    type: metadata.type || 'Equity',
                    provider: metadata.provider || 'external',
                  },
                },
              },
              suggestedTokenType: metadata.type || 'other',
            };

            errorSet.delete('User selection required');
            errorSet.delete('Token not found');
          } catch (error) {
            console.error('Failed to parse external token metadata:', error);
            errorSet.add('Failed to parse selected token metadata');
          }
        } else {
          updatedHolding = {
            ...updatedHolding,
            tokenId: selectedTokenId,
            tokenExists: true,
            requiresUserSelection: false,
          };
          errorSet.delete('User selection required');
          errorSet.delete('Token not found');
        }
      }

      if (updatedHolding.processingAction === 'create') {
        updatedHolding = {
          ...updatedHolding,
          existingHoldingId: undefined,
        };
        errorSet.delete('Select existing holding to update');
      } else if (updatedHolding.processingAction === 'update-existing') {
        if (!updatedHolding.existingHoldingId) {
          errorSet.add('Select existing holding to update');
        } else {
          errorSet.delete('Select existing holding to update');
        }
      }

      updatedHolding = {
        ...updatedHolding,
        errors: Array.from(errorSet),
      };

      nextHoldings.push(updatedHolding);

      const {
        processingAction: _processingAction,
        availableExistingHoldings: _availableExistingHoldings,
        ...sanitized
      } = updatedHolding;
      sanitizedHoldings.push(sanitized);
    });

    setEditableHoldings(nextHoldings);
    return sanitizedHoldings;
  }, [editableHoldings, editableHoldingTokenIds]);

  const deleteHolding = (index: number) => {
    if (isScreenshotBusy) {
      return;
    }
    setEditableHoldings((prev) => prev.filter((_, i) => i !== index));
    // Remove the stable key for this row
    rowKeysRef.current.splice(index, 1);
    // Update token selections - remove deleted index and shift remaining ones
    setEditableHoldingTokenIds((prev) => {
      const updated = { ...prev };
      delete updated[index];

      // Shift indices that are greater than the deleted index
      const shifted: Record<number, string> = {};
      Object.entries(updated).forEach(([key, value]) => {
        const numKey = parseInt(key, 10);
        if (numKey > index) {
          shifted[numKey - 1] = value;
        } else {
          shifted[numKey] = value;
        }
      });

      return shifted;
    });
  };

  const addNewHolding = () => {
    if (isScreenshotBusy) {
      return;
    }
    const newHolding: EditableHoldingState = {
      symbol: '',
      name: '',
      balance: '',
      confidence: 1,
      tokenExists: false,
      errors: [],
      warnings: [],
      processingAction: 'create',
      availableExistingHoldings: [],
    };
    setEditableHoldings((prev) => [...prev, newHolding]);
    rowKeysRef.current.push(`eh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  };

  // Helper functions for per-row edit mode
  const toggleEditMode = (index: number) => {
    if (isScreenshotBusy) {
      return;
    }
    setEditingHoldingIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const isEditingHolding = (index: number) => editingHoldingIds.has(index);

  const getHoldingStatus = (holding: EditableHoldingState) => {
    if (holding.processingAction === 'update-existing' && holding.existingHoldingId) {
      const existingHolding = existingHoldingsById.get(holding.existingHoldingId);

      if (existingHolding) {
        const currentBalance = Number.parseFloat(existingHolding.balance);
        const newBalance = Number.parseFloat(holding.balance);
        const difference = newBalance - currentBalance;

        return {
          type: 'update' as const,
          currentBalance: existingHolding.balance,
          difference: Number.isFinite(difference) ? difference.toString() : '0',
          isIncrease: difference > 0,
          reference: existingHolding,
        };
      }
    }

    return { type: 'create' as const };
  };

  // Step navigation functions

  const handleEntryMethodSelected = (method: 'manual' | 'screenshot' | 'wallet') => {
    if (method === 'wallet') {
      // Wallet import doesn't need account selection (creates accounts automatically)
      setCurrentStep('wallet-entry');
      return;
    }

    // Store the selected method
    setSelectedEntryMethod(method);

    // Check if we need to select an account first
    if (shouldSkipAccountSelection) {
      // Account is pre-selected, go directly to entry form
      if (method === 'manual') {
        setCurrentStep('manual-entry');
      } else {
        setCurrentStep('screenshot-entry');
      }
    } else {
      // Need to select account first
      setCurrentStep('account-selection');
    }
  };

  const goBack = () => {
    switch (currentStep) {
      case 'entry-method':
        // First step, go back to previous page
        navigate(-1);
        break;
      case 'account-selection':
        // Go back to entry method selection
        setCurrentStep('entry-method');
        break;
      case 'manual-entry':
      case 'screenshot-entry':
        // If account was pre-selected, skip account selection
        if (shouldSkipAccountSelection) {
          setCurrentStep('entry-method');
        } else {
          setCurrentStep('account-selection');
        }
        break;
      default:
        navigate(-1);
    }
  };

  // Watch for account changes to update selected account state
  const watchedAccountId = form.watch('accountId');
  useEffect(() => {
    if (watchedAccountId && watchedAccountId !== preSelectedAccountId) {
      setSelectedAccountId(watchedAccountId);
    }
  }, [watchedAccountId, preSelectedAccountId]);

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

  // Validation for account selection step specifically
  const isAccountSelectionValid = useMemo(() => {
    const errors = form.formState.errors;
    const accountId = formValues.accountId || selectedAccountId;

    // If no account selected at all, invalid
    if (!accountId) return false;

    // If existing account selected, valid
    if (accountId !== 'new') return true;

    // If creating new account, check required fields
    if (!formValues.newAccountName?.trim() || errors.newAccountName) return false;
    if (!formValues.newAccountType || errors.newAccountType) return false;
    if (!formValues.institutionId || errors.institutionId) return false;

    // If creating new institution, check required institution fields
    if (formValues.institutionId === 'new') {
      if (!formValues.newInstitutionName?.trim() || errors.newInstitutionName) return false;
      if (!formValues.newInstitutionType || errors.newInstitutionType) return false;
    }

    return true;
  }, [formValues, form.formState.errors, selectedAccountId]);

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

  // Handle account creation when moving from account selection to next step
  const handleAccountCreation = async () => {
    const formData = form.getValues();
    const accountId = formData.accountId || selectedAccountId;

    if (accountId !== 'new') {
      // Existing account selected, no need to create
      return accountId;
    }

    try {
      let institutionId = formData.institutionId;

      // Step 1: Create institution if needed
      if (institutionId === 'new') {
        console.log('Creating institution:', {
          name: formData.newInstitutionName,
          type: formData.newInstitutionType,
          description: formData.newInstitutionDescription || '',
          website: formData.newInstitutionWebsite || '',
        });

        const newInstitution = await createInstitution.mutateAsync({
          name: formData.newInstitutionName!.trim(),
          type: formData.newInstitutionType!,
          description: formData.newInstitutionDescription?.trim() || '',
          website: formData.newInstitutionWebsite?.trim() || '',
        });

        if (!newInstitution?.id) {
          throw new Error('Failed to create institution - no ID returned');
        }

        institutionId = newInstitution.id;
        console.log('Institution created successfully:', institutionId);
      }

      // Step 2: Create account
      console.log('Creating account:', {
        name: formData.newAccountName,
        type: formData.newAccountType,
        institutionId: institutionId,
        description: formData.newAccountDescription || '',
      });

      const newAccount = await createAccount.mutateAsync({
        name: formData.newAccountName!.trim(),
        type: formData.newAccountType!,
        institutionId: institutionId!,
        description: formData.newAccountDescription?.trim() || '',
      });

      if (!newAccount?.id) {
        throw new Error('Failed to create account - no ID returned');
      }

      // Update form and state with the new account ID
      form.setValue('accountId', newAccount.id);
      setSelectedAccountId(newAccount.id);

      toast({
        title: '✅ Account Created',
        description: `Account "${newAccount.name}" has been successfully created.`,
      });

      return newAccount.id;
    } catch (error) {
      console.error('Account creation failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      toast({
        title: '❌ Failed to Create Account',
        description: errorMessage,
        variant: 'destructive',
      });

      throw error;
    }
  };

  const onSubmit = async (data: AddDataFormData) => {
    setIsSubmitting(true);

    try {
      // Use form accountId or fallback to currently selected account
      let accountId = data.accountId || currentlySelectedAccountId;
      let tokenId = data.tokenId;
      let institutionId = data.institutionId;

      console.log(
        'Form submission - accountId:',
        accountId,
        'currentlySelectedAccountId:',
        currentlySelectedAccountId
      );

      // Handle external token creation if needed
      if (isExternalTokenValue(tokenId)) {
        try {
          const externalTokenData = parseExternalTokenValue(tokenId)!;

          console.log('Creating external token:', externalTokenData);

          const provider: TokenProvider =
            externalTokenData.provider === 'coingecko' ? 'coingecko' : 'finnhub';

          const newToken = await withRetry(
            () =>
              createTokenFromExternal.mutateAsync({
                symbol: externalTokenData.symbol,
                provider,
                metadata: {
                  ...externalTokenData.metadata,
                  name: externalTokenData.name,
                },
              }),
            {
              retries: 2,
              baseDelayMs: 800,
              maxDelayMs: 4000,
              strategy: 'exponential',
              shouldRetry: (e: unknown) => {
                const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
                return (
                  msg.includes('network') ||
                  msg.includes('timeout') ||
                  msg.includes('connection') ||
                  msg.includes('rate')
                );
              },
            }
          );

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
      if (accountId === 'new' && data.institutionId === 'new') {
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

          // CRITICAL FIX: Wait for institution to settle in cache
          await waitForCacheSettlement('institutions', institutionId);

          console.log('Institution created and settled:', institutionId);
        } catch (error) {
          console.error('Institution creation failed:', error);
          throw new Error(
            `Failed to create institution: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }
      }

      // Step 2: Create account if needed (only if not already created)
      if (accountId === 'new') {
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

          // CRITICAL FIX: Wait for account to settle in cache
          await waitForCacheSettlement('accounts', accountId);

          console.log('Account created and settled:', accountId);
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

        const createdHolding = await createHolding.mutateAsync({
          accountId,
          tokenId,
          balance: data.balance.toString(),
        });

        if (!createdHolding?.id) {
          throw new Error('Failed to create holding - no ID returned');
        }

        // Invalidate caches first to trigger refetch
        await Promise.all([
          utils.holdings.getAll.invalidate(),
          utils.accounts.getAll.invalidate(),
          utils.institutions.getAll.invalidate(),
          utils.tokens.getAll.invalidate(),
        ]);

        // Then wait for holding to appear in the refetched cache
        await waitForCacheSettlement('holdings', createdHolding.id);

        console.log('Holding created and settled:', createdHolding.id);

        toast({
          title: '✅ Success!',
          description:
            'Holding created successfully! Your new holding has been added to your portfolio.',
        });

        // Give React Query a moment to finish processing before navigation
        await new Promise((resolve) => setTimeout(resolve, 100));

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

  // Step components
  const renderAccountSelection = () => (
    <div className="space-y-6">
      <PageHeader
        title="Add Data"
        subtitle="First, select which account you'd like to add your data to."
      />

      <div className="space-y-4">
        <Label htmlFor={accountSelectId} className="text-base font-medium">
          Select Account
        </Label>
        <AccountSelector
          id={accountSelectId}
          value={selectedAccountId}
          onValueChange={(accountId: string) => {
            setSelectedAccountId(accountId);
            form.setValue('accountId', accountId);
          }}
          accounts={accounts}
          institutions={institutions}
          placeholder="Choose an account..."
        />

        {/* New Account Creation Form */}
        {selectedAccountId === 'new' && (
          <div className="space-y-4 border-t pt-4">
            {/* Institution Selection - First */}
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

              {form.watch('institutionId') === 'new' && (
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

            {/* Account Details - Second */}
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

        <div className="flex justify-between items-center pt-8">
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              try {
                await handleAccountCreation();
                // Navigate to the selected entry method
                if (selectedEntryMethod === 'manual') {
                  setCurrentStep('manual-entry');
                } else if (selectedEntryMethod === 'screenshot') {
                  setCurrentStep('screenshot-entry');
                } else {
                  // Fallback to manual entry if no method selected
                  setCurrentStep('manual-entry');
                }
              } catch (error) {
                // Error already handled in handleAccountCreation
                console.error('Failed to create account:', error);
              }
            }}
            disabled={
              !isAccountSelectionValid || createAccount.isPending || createInstitution.isPending
            }
          >
            {createAccount.isPending || createInstitution.isPending ? (
              <>
                <LoadingSpinner className="mr-2 h-4 w-4" />
                Creating Account...
              </>
            ) : (
              'Continue'
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  const handleWalletImport = async () => {
    if (!walletAddress.trim()) {
      toast({
        variant: 'destructive',
        title: 'Invalid Input',
        description: 'Please enter a valid wallet address',
      });
      return;
    }

    setIsImportingWallet(true);

    try {
      const result = await importWallet.mutateAsync({
        walletAddress: walletAddress.trim(),
      });

      // Invalidate related queries to refresh data
      await Promise.all([
        utils.accounts.getAll.invalidate(),
        utils.holdings.getAll.invalidate(),
        utils.tokens.getAll.invalidate(),
      ]);

      toast({
        title: 'Wallet Import Successful!',
        description: (
          <div className="space-y-2">
            <p>
              Successfully imported {result.holdingsCreated} holdings across{' '}
              {result.accountsCreated} accounts
            </p>
            {result.accountsSkipped > 0 && (
              <p className="text-sm text-muted-foreground">
                ({result.accountsSkipped} account(s) already existed)
              </p>
            )}
          </div>
        ),
      });

      // Navigate to holdings page to show imported data
      navigate('/holdings');
    } catch (error) {
      console.error('Wallet import failed:', error);
      toast({
        variant: 'destructive',
        title: 'Import Failed',
        description:
          error instanceof Error
            ? error.message
            : 'Failed to import wallet. Please check the address and try again.',
      });
    } finally {
      setIsImportingWallet(false);
    }
  };

  const renderWalletEntry = () => (
    <div className="relative flex min-h-screen flex-col">
      <div className="flex-1 space-y-6 pb-32">
        <PageHeader
          title="Add Data - Wallet Import"
          subtitle="Import holdings automatically from your crypto wallet address"
        />

        <Card>
          <CardHeader>
            <CardTitle>Enter Wallet Address</CardTitle>
            <CardDescription>
              We'll automatically detect your wallet type and import balances from all supported
              chains
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={walletInputId}>Wallet Address</Label>
              <Input
                id={walletInputId}
                placeholder="0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                disabled={isImportingWallet}
              />
              <p className="text-sm text-muted-foreground">
                Supported: EVM (Ethereum, Polygon, BSC, Arbitrum, Base), Bitcoin, Tron, Solana, and
                12+ other chains
              </p>
            </div>

            <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <div className="flex items-start space-x-2">
                <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                    What happens next?
                  </p>
                  <ul className="text-xs text-blue-600 dark:text-blue-400 space-y-1 list-disc list-inside">
                    <li>System detects your wallet type automatically</li>
                    <li>Fetches native token + ERC-20 token balances from all chains</li>
                    <li>Creates accounts for each chain with balances</li>
                    <li>Creates holdings for all tokens found</li>
                    <li>All data will be available in your dashboard immediately</li>
                  </ul>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-between items-center pt-8">
          <Button type="button" variant="outline" onClick={goBack} disabled={isImportingWallet}>
            Back
          </Button>
          <Button
            onClick={handleWalletImport}
            disabled={isImportingWallet || !walletAddress.trim()}
          >
            {isImportingWallet ? (
              <>
                <LoadingSpinner className="mr-2 h-4 w-4" />
                Importing Wallet...
              </>
            ) : (
              'Import Wallet'
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  const renderEntryMethodSelection = () => (
    <div className="space-y-6">
      <PageHeader title="Add Data" subtitle="Choose how you want to add data to your portfolio" />

      {/* Show selected account info */}
      {currentlySelectedAccount && (
        <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex items-center space-x-2">
            <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <div>
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                Your data will be added to: {currentlySelectedAccount.name}
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                After completing this form, your new holdings will be added to this account and will
                appear in your portfolio.
              </p>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="grid gap-4 md:grid-cols-3">
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => handleEntryMethodSelected('manual')}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PenTool className="h-5 w-5" />
                Manual Entry
              </CardTitle>
              <CardDescription>Enter holding details manually using forms</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Perfect for entering holdings step by step with full control over all details.
              </p>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => handleEntryMethodSelected('screenshot')}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Screenshot Upload
              </CardTitle>
              <CardDescription>Upload a screenshot and let AI extract the details</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Take a photo of your portfolio and we'll automatically detect holdings.
              </p>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => handleEntryMethodSelected('wallet')}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5" />
                Crypto Wallet
              </CardTitle>
              <CardDescription>Import holdings from your wallet address</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Enter your wallet address to automatically import balances from all supported
                chains.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="flex justify-between items-center pt-8">
          <Button type="button" variant="outline" onClick={goBack}>
            Back
          </Button>
          <div></div> {/* Spacer */}
        </div>
      </div>
    </div>
  );

  const renderScreenshotEntry = () => (
    <div className="relative flex min-h-screen flex-col">
      <div className="flex-1 space-y-6 pb-32">
        <PageHeader
          title="Add Data - Screenshot Upload"
          subtitle={
            currentlySelectedAccount
              ? `Adding to: ${currentlySelectedAccount.name} • Upload a screenshot to automatically extract holdings.`
              : 'Upload a screenshot to automatically extract holdings.'
          }
        />

        {/* Show selected account info */}
        {currentlySelectedAccount && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center space-x-2">
              <Info className="h-4 w-4 text-blue-600" />
              <div>
                <p className="text-sm font-medium text-blue-800">
                  Your holdings will be added to: {currentlySelectedAccount.name}
                </p>
                <p className="text-xs text-blue-600 mt-0.5">
                  After uploading and reviewing your screenshot, the detected holdings will be added
                  to this account.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-6">
          {screenshotParsing.state === 'upload' && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Upload Portfolio Screenshots</h3>
              <p className="text-muted-foreground">
                Take screenshots or photos of your portfolio, trading apps, or any screens showing
                your holdings. You can upload multiple screenshots at once. Our AI will
                automatically detect and extract the token symbols and balances from all images.
              </p>

              <ScreenshotUpload
                allowMultiple={true}
                maxFiles={5}
                onImageUpload={(base64: string, fileName: string) => {
                  // Fallback for single image upload
                  if (currentlySelectedAccountId) {
                    screenshotParsing.handleImageUpload(
                      base64,
                      fileName,
                      currentlySelectedAccountId
                    );
                  } else {
                    toast({
                      title: 'No account selected',
                      description: 'Please go back and select an account first.',
                      variant: 'destructive',
                    });
                  }
                }}
                onMultipleImageUpload={(files) => {
                  if (currentlySelectedAccountId) {
                    screenshotParsing.handleMultipleImageUpload(files, currentlySelectedAccountId);
                  } else {
                    toast({
                      title: 'No account selected',
                      description: 'Please go back and select an account first.',
                      variant: 'destructive',
                    });
                  }
                }}
                isProcessing={isScreenshotBusy}
                maxSizeMB={10}
              />
            </div>
          )}

          {screenshotParsing.state === 'parsing' && (
            <div className="text-center py-8 space-y-6">
              <LoadingSpinner className="h-8 w-8 mx-auto mb-4" />
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">
                  {screenshotParsing.processingProgress
                    ? `Analyzing Screenshots...`
                    : 'Analyzing Screenshot...'}
                </h3>

                {screenshotParsing.processingProgress && (
                  <div className="max-w-md mx-auto space-y-3">
                    <div className="space-y-2">
                      <Progress value={undefined} className="w-full animate-pulse" />
                      <div className="text-xs text-muted-foreground text-center">
                        Processing screenshots in parallel...
                      </div>
                    </div>
                  </div>
                )}

                <p className="text-muted-foreground">
                  {screenshotParsing.processingProgress
                    ? `Processing ${screenshotParsing.processingProgress.total} screenshots in parallel. Each image takes 10-30 seconds.`
                    : 'Our AI is extracting holdings from your screenshot. This usually takes 10-30 seconds.'}
                </p>
              </div>
            </div>
          )}

          {(screenshotParsing.state === 'review' || screenshotParsing.state === 'processing') &&
            (screenshotParsing.parsingResults || screenshotParsing.multipleResults) && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold mb-2">Review Detected Holdings</h3>
                  <p className="text-muted-foreground mb-4">
                    Please review the holdings we detected and make any necessary adjustments before
                    adding them to your account.
                  </p>
                </div>

                {/* Summary */}
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                  {screenshotParsing.multipleResults ? (
                    <>
                      <div className="mb-4 text-sm text-muted-foreground">
                        Analysis from{' '}
                        {screenshotParsing.multipleResults.overallSummary.totalScreenshots}{' '}
                        screenshots
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <span className="font-medium">Total Holdings:</span>
                          <div className="text-lg font-semibold">
                            {screenshotParsing.multipleResults.overallSummary.totalHoldings}
                          </div>
                        </div>
                        <div>
                          <span className="font-medium">Existing Tokens:</span>
                          <div className="text-lg font-semibold text-green-600">
                            {screenshotParsing.multipleResults.overallSummary.existingTokens}
                          </div>
                        </div>
                        <div>
                          <span className="font-medium">New Tokens:</span>
                          <div className="text-lg font-semibold text-orange-600">
                            {screenshotParsing.multipleResults.overallSummary.newTokensRequired}
                          </div>
                        </div>
                        <div>
                          <span className="font-medium">Avg Confidence:</span>
                          <div className="text-lg font-semibold">
                            {Math.round(
                              screenshotParsing.multipleResults.overallSummary.averageConfidence *
                                100
                            )}
                            %
                          </div>
                        </div>
                      </div>
                    </>
                  ) : screenshotParsing.parsingResults ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <span className="font-medium">Total Holdings:</span>
                        <div className="text-lg font-semibold">
                          {screenshotParsing.parsingResults.summary.totalHoldings}
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">Existing Tokens:</span>
                        <div className="text-lg font-semibold text-green-600">
                          {screenshotParsing.parsingResults.summary.existingTokens}
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">New Tokens:</span>
                        <div className="text-lg font-semibold text-orange-600">
                          {screenshotParsing.parsingResults.summary.newTokensRequired}
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">Avg Confidence:</span>
                        <div className="text-lg font-semibold">
                          {Math.round(
                            screenshotParsing.parsingResults.summary.averageConfidence * 100
                          )}
                          %
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Holdings List - Editable */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-base font-medium">Holdings to Add</h4>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addNewHolding}
                        disabled={isScreenshotBusy}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add Holding
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {editableHoldings.map((holding, index) => {
                      const status = getHoldingStatus(holding);
                      const hasErrors = holding.requiresUserSelection || holding.errors.length > 0;
                      const isEditing = isEditingHolding(index);

                      return (
                        <div
                          key={rowKeysRef.current[index] || `${index}`}
                          className={`border rounded-lg p-4 ${
                            hasErrors ? 'border-yellow-300 bg-yellow-50' : 'border-border'
                          }`}
                        >
                          {/* Error Message at Top */}
                          {hasErrors && (
                            <div className="mb-3 flex items-start gap-2 p-2 bg-yellow-100 border border-yellow-300 rounded">
                              <AlertCircle className="h-4 w-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                              <div className="text-sm text-yellow-800">
                                {holding.errors.join(', ')}
                              </div>
                            </div>
                          )}

                          {isEditing ? (
                            // Edit Mode
                            <div className="space-y-3">
                              <div className="flex items-start gap-3">
                                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div>
                                    <Label className="text-xs text-muted-foreground">Token *</Label>
                                    <AsyncTokenSelector
                                      value={editableHoldingTokenIds[index] || ''}
                                      onValueChange={(tokenId) => {
                                        setEditableHoldingTokenIds((prev) => ({
                                          ...prev,
                                          [index]: tokenId,
                                        }));

                                        // Update holding with selected token info
                                        let updateData: Partial<ParsedHolding> = {};

                                        if (isExternalTokenValue(tokenId)) {
                                          // Handle external token selection
                                          try {
                                            const parts = tokenId.split(':');
                                            const metadata = JSON.parse(parts.slice(2).join(':'));
                                            console.log(
                                              'Parsed external token metadata:',
                                              metadata
                                            );
                                            updateData = {
                                              symbol: metadata.symbol,
                                              name: metadata.name,
                                              tokenExists: false,
                                              requiresUserSelection: false,
                                              errors: [], // Clear errors when token is selected
                                              providerValidation: {
                                                exactMatch: {
                                                  isValid: true,
                                                  metadata: {
                                                    ...metadata,
                                                    type: metadata.type || 'Equity', // Ensure type is always present
                                                  },
                                                },
                                              },
                                              suggestedTokenType: metadata.type || 'other',
                                            };
                                          } catch (error) {
                                            console.error(
                                              'Failed to parse external token metadata:',
                                              error
                                            );
                                          }
                                        } else {
                                          const selectedToken = allTokens?.find(
                                            (t) => t.id === tokenId
                                          );
                                          if (selectedToken) {
                                            updateData = {
                                              symbol: selectedToken.symbol,
                                              name: selectedToken.name || '',
                                              tokenId: selectedToken.id,
                                              tokenExists: true,
                                              requiresUserSelection: false,
                                              errors: [], // Clear errors when token is selected
                                            };
                                          }
                                        }

                                        if (Object.keys(updateData).length > 0) {
                                          updateHolding(index, updateData);
                                        }
                                      }}
                                      placeholder={
                                        holding.requiresUserSelection
                                          ? 'Select from provider suggestions...'
                                          : 'Search for a token...'
                                      }
                                      className="h-8"
                                      disabled={isScreenshotBusy}
                                      suggestedTokens={
                                        holding.requiresUserSelection &&
                                        holding.providerValidation?.similarMatches
                                          ? holding.providerValidation.similarMatches
                                              .filter((match) => match.metadata)
                                              .map((match) => ({
                                                symbol: match.metadata!.symbol,
                                                name: match.metadata!.name,
                                                type: match.metadata!.type.toLowerCase(),
                                                source: 'external' as const,
                                                provider: match.metadata!.provider as
                                                  | 'finnhub'
                                                  | 'coingecko',
                                                metadata: match.metadata,
                                              }))
                                          : undefined
                                      }
                                      prefillSymbol={
                                        holding.requiresUserSelection ? holding.symbol : undefined
                                      }
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-xs text-muted-foreground">
                                      Balance *
                                    </Label>
                                    <Input
                                      value={holding.balance}
                                      onChange={(e) =>
                                        updateHolding(index, {
                                          balance: e.target.value,
                                          errors: holding.errors.filter(
                                            (error) =>
                                              !error.includes('Valid balance amount is required')
                                          ),
                                        })
                                      }
                                      placeholder="e.g. 1.234"
                                      type="text"
                                      inputMode="decimal"
                                      className="h-8"
                                      disabled={isScreenshotBusy}
                                    />
                                  </div>
                                  {holding.availableExistingHoldings.length > 0 && (
                                    <div className="md:col-span-2">
                                      <Label className="text-xs text-muted-foreground">
                                        Apply to existing holding
                                      </Label>
                                      <Select
                                        value={
                                          holding.processingAction === 'update-existing' &&
                                          holding.existingHoldingId
                                            ? holding.existingHoldingId
                                            : 'create'
                                        }
                                        onValueChange={(value) => {
                                          if (value === 'create') {
                                            updateHolding(index, {
                                              processingAction: 'create',
                                              existingHoldingId: undefined,
                                              errors: holding.errors.filter(
                                                (error) =>
                                                  !error.includes('Select existing holding')
                                              ),
                                            });
                                          } else {
                                            updateHolding(index, {
                                              processingAction: 'update-existing',
                                              existingHoldingId: value,
                                              errors: holding.errors.filter(
                                                (error) =>
                                                  !error.includes('Select existing holding')
                                              ),
                                            });
                                          }
                                        }}
                                        disabled={isScreenshotBusy}
                                      >
                                        <SelectTrigger className="h-8">
                                          <SelectValue placeholder="Create new holding" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="create">Create new holding</SelectItem>
                                          {holding.availableExistingHoldings.map((option) => {
                                            const lastUpdated = option.lastUpdated
                                              ? new Date(option.lastUpdated).toLocaleDateString()
                                              : null;

                                            return (
                                              <SelectItem key={option.id} value={option.id}>
                                                {option.tokenSymbol || option.tokenId}
                                                {option.tokenName ? ` (${option.tokenName})` : ''}
                                                {option.balance
                                                  ? ` • Balance ${option.balance}`
                                                  : ''}
                                                {lastUpdated ? ` • Updated ${lastUpdated}` : ''}
                                              </SelectItem>
                                            );
                                          })}
                                        </SelectContent>
                                      </Select>
                                      {(() => {
                                        if (
                                          holding.processingAction === 'update-existing' &&
                                          holding.existingHoldingId
                                        ) {
                                          const targetOption =
                                            holding.availableExistingHoldings.find(
                                              (option) => option.id === holding.existingHoldingId
                                            );
                                          return (
                                            <p className="mt-1 text-xs text-muted-foreground">
                                              Updating existing holding
                                              {targetOption?.balance
                                                ? ` with current balance ${targetOption.balance}`
                                                : ''}
                                              .
                                            </p>
                                          );
                                        }
                                        return null;
                                      })()}
                                    </div>
                                  )}
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => deleteHolding(index)}
                                  className="h-8 w-8 p-0 text-red-500 hover:text-red-700"
                                  disabled={isScreenshotBusy}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>

                              {holding.notes && (
                                <div>
                                  <Label className="text-xs text-muted-foreground">Notes</Label>
                                  <Input
                                    value={holding.notes}
                                    onChange={(e) =>
                                      updateHolding(index, {
                                        notes: e.target.value,
                                      })
                                    }
                                    placeholder="Optional notes..."
                                    className="h-8"
                                    disabled={isScreenshotBusy}
                                  />
                                </div>
                              )}
                            </div>
                          ) : (
                            // View Mode
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="font-medium text-lg">
                                    {holding.symbol || 'Unknown Symbol'}
                                  </span>
                                  {holding.name && (
                                    <span className="text-muted-foreground">({holding.name})</span>
                                  )}

                                  {/* Status Badge */}
                                  {status.type === 'create' ? (
                                    <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                                      New Holding
                                    </span>
                                  ) : status.type === 'update' ? (
                                    <span
                                      className={`text-xs px-2 py-1 rounded ${
                                        status.isIncrease
                                          ? 'bg-blue-100 text-blue-800'
                                          : 'bg-yellow-100 text-yellow-800'
                                      }`}
                                    >
                                      {status.isIncrease ? 'Increase' : 'Decrease'} by{' '}
                                      {Math.abs(Number.parseFloat(status.difference)).toFixed(6)}
                                    </span>
                                  ) : null}

                                  {!holding.tokenExists && (
                                    <span className="text-xs bg-orange-100 text-orange-800 px-2 py-1 rounded">
                                      New Token
                                    </span>
                                  )}
                                </div>

                                <div className="space-y-1">
                                  <div className="text-sm">
                                    <span className="text-muted-foreground">Balance:</span>{' '}
                                    <span className="font-medium">{holding.balance || '0'}</span>
                                  </div>

                                  {status.type === 'update' && (
                                    <div className="text-sm">
                                      <span className="text-muted-foreground">Current:</span>{' '}
                                      <span>{status.reference?.balance ?? '—'}</span>
                                      {' → '}
                                      <span className="font-medium">{holding.balance}</span>
                                    </div>
                                  )}
                                  {status.type === 'update' && status.reference && (
                                    <div className="text-xs text-muted-foreground">
                                      Updating existing holding
                                      {status.reference.tokenSymbol
                                        ? ` (${status.reference.tokenSymbol})`
                                        : ''}
                                      .
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <div className="text-right space-y-1">
                                  <div
                                    className={`text-sm font-medium ${
                                      holding.confidence >= 0.8
                                        ? 'text-green-600'
                                        : holding.confidence >= 0.6
                                          ? 'text-yellow-600'
                                          : 'text-red-600'
                                    }`}
                                  >
                                    {Math.round(holding.confidence * 100)}% confidence
                                  </div>
                                </div>

                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => toggleEditMode(index)}
                                  className="h-8 w-8 p-0"
                                  disabled={isScreenshotBusy}
                                >
                                  <PenTool className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          )}

                          {holding.notes && !isEditing && (
                            <div className="mt-3 pt-3 border-t text-sm text-muted-foreground">
                              <strong>Note:</strong> {holding.notes}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

          {screenshotParsing.state === 'error' && (
            <div className="text-center py-8">
              <div className="text-red-500 mb-4">
                <AlertCircle className="h-12 w-12 mx-auto mb-2" />
                <h3 className="text-lg font-semibold">Error Processing Screenshot</h3>
              </div>
              <p className="text-muted-foreground mb-4">{screenshotParsing.errorMessage}</p>
              <Button onClick={() => screenshotParsing.handleRetry()}>Try Again</Button>
            </div>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 left-0 right-0 z-40 border-t border-border/70 bg-background/95 px-4 py-4 shadow-[0_-1px_3px_rgba(15,23,42,0.08)] backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4">
          <Button type="button" variant="outline" onClick={goBack} disabled={isScreenshotBusy}>
            Back
          </Button>

          <div className="flex flex-1 items-center justify-end gap-4">
            {(screenshotParsing.state === 'review' || isScreenshotProcessing) &&
              (screenshotParsing.parsingResults || screenshotParsing.multipleResults) &&
              (() => {
                const creates = editableHoldings.filter((h) => {
                  const status = getHoldingStatus(h);
                  return status.type === 'create';
                }).length;

                const updates = editableHoldings.filter((h) => {
                  const status = getHoldingStatus(h);
                  return status.type === 'update';
                }).length;

                let buttonText = 'Process Holdings';
                if (creates > 0 && updates > 0) {
                  buttonText = `Add ${creates} New, Update ${updates} Existing`;
                } else if (creates > 0) {
                  buttonText = `Add ${creates} New Holdings`;
                } else if (updates > 0) {
                  buttonText = `Update ${updates} Holdings`;
                }

                const hasUnresolvedIssues = editableHoldings.some(
                  (holding) => holding.requiresUserSelection || holding.errors.length > 0
                );

                return (
                  <Button
                    onClick={() => {
                      if (currentlySelectedAccountId && !isScreenshotBusy) {
                        const synchronizedHoldings = synchronizeTokenSelections();
                        screenshotParsing.handleProcessHoldings(
                          synchronizedHoldings,
                          currentlySelectedAccountId
                        );
                      }
                    }}
                    disabled={isScreenshotBusy || hasUnresolvedIssues}
                  >
                    {isScreenshotBusy ? (
                      <>
                        <LoadingSpinner className="mr-2 h-4 w-4" />
                        {baseFinalizingMessage}
                      </>
                    ) : (
                      buttonText
                    )}
                  </Button>
                );
              })()}
          </div>
        </div>
      </div>

      {(screenshotParsing.state === 'processing' || screenshotParsing.isFinalizing) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-900/60 backdrop-blur-sm">
          <div className="mx-4 max-w-md rounded-lg border border-blue-200 bg-blue-50/95 p-6 text-center shadow-xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/80">
              <LoadingSpinner className="h-6 w-6 text-blue-700" />
            </div>
            <h3 className="text-lg font-semibold text-blue-900">Processing holdings</h3>
            <p className="mt-2 text-sm text-blue-800">
              {baseFinalizingMessage}
              {!screenshotParsing.finalizingMessage && ' This may take a few seconds.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );

  const renderManualEntry = () => (
    <div className="space-y-4">
      <PageHeader
        title="Add Holding"
        subtitle={
          currentlySelectedAccount
            ? `Adding to: ${currentlySelectedAccount.name} • Enter your holding details below.`
            : 'Enter your holding details below.'
        }
      />

      {/* Show selected account info */}
      {currentlySelectedAccount && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center space-x-2">
            <Info className="h-4 w-4 text-blue-600" />
            <div>
              <p className="text-sm font-medium text-blue-800">
                Adding holding to: {currentlySelectedAccount.name}
              </p>
              <p className="text-xs text-blue-600 mt-0.5">
                Fill out the form below to add a new holding to this account. All required fields
                are marked with *.
              </p>
            </div>
          </div>
        </div>
      )}

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
                  } else if (isExternalTokenValue(value)) {
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

        {/* Account Selection - Only show if account is 'new' (not pre-selected) */}
        {!currentlySelectedAccount && (
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
                  institutions={institutions}
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
        )}

        {/* Submit Actions */}
        <div className="flex justify-between items-center pt-6">
          <Button type="button" variant="outline" onClick={goBack}>
            Back
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
    </div>
  );

  // Main render logic based on current step
  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-center py-12">
              <LoadingSpinner className="h-8 w-8" />
              <span className="ml-2">Loading...</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          {currentStep === 'account-selection' && renderAccountSelection()}
          {currentStep === 'entry-method' && renderEntryMethodSelection()}
          {currentStep === 'manual-entry' && renderManualEntry()}
          {currentStep === 'screenshot-entry' && renderScreenshotEntry()}
          {currentStep === 'wallet-entry' && renderWalletEntry()}
        </>
      )}

      {/* Token Creation Dialog */}
      <PrivateTokenForm
        isOpen={isTokenFormOpen}
        onClose={() => setIsTokenFormOpen(false)}
        mode="create"
        token={null}
        onSuccess={(token) => {
          // Invalidate tokens queries to refresh the AsyncTokenSelector
          void utils.tokens.getAll.invalidate();

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
