import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from "@/components/selectors/SearchableSelectors";
import { TokenSearchableSelector } from "@/components/selectors/TokenSearchableSelector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isExternalTokenValue,
  parseExternalTokenValue,
} from "@/lib/external-token";
import { trpc } from "@/lib/trpc";

type Step = "method" | "account" | "data";

type CompleteImportData = {
  // Method selection data
  method?: "manual" | "screenshots" | "wallet";

  // Account selection data
  accountSelection?: {
    mode: "select" | "create";
    selectedAccountId?: string;
    newAccountData?: {
      name: string;
      typeId: string;
      institutionSelection?: {
        mode: "select" | "create";
        selectedInstitutionId?: string;
        newInstitutionData?: {
          name: string;
          typeId: string;
          website: string;
          description: string;
        };
      };
    };
  };

  // Data entry data (for future use)
  dataEntry?: {
    holdings?: Array<{
      id: string;
      tokenValue: string;
      amount: string;
      isExisting?: boolean; // New field to distinguish existing vs new holdings
      originalAmount?: string; // Track original amount for change detection
    }>;
  };
};

export function AddData() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState<Step>("method");
  const [navContainer, setNavContainer] = useState<Element | null>(null);
  const [isAccountStepValid, setIsAccountStepValid] = useState(false);
  const [accountDisplayText, setAccountDisplayText] =
    useState<string>("Choose Account");
  const [hasDataChanges, setHasDataChanges] = useState(false);

  const createTokensFromExternalMutation =
    trpc.tokens.createManyfromExternal.useMutation();

  const createTokenFromExternalMutation =
    trpc.tokens.createFromExternal.useMutation();
  const createHoldingsWithDependenciesMutation =
    trpc.batchOperations.createHoldingsWithDependencies.useMutation();
  const updateHoldingsBatchMutation =
    trpc.batchOperations.updateHoldingsBatch.useMutation();
  const updateHoldingMutation = trpc.holdings.update.useMutation({
    onSuccess: () => {
      // Invalidate all related queries using utility function
    },
  });
  const [completeImportData, setCompleteImportData] =
    useState<CompleteImportData>({});

  const selectedAccountId =
    completeImportData.accountSelection?.selectedAccountId;

  useEffect(() => {
    const container = document.getElementById("mobile-bottom-nav");
    setNavContainer(container);
  }, []);

  // Load form data from URL params on mount
  useEffect(() => {
    const method = searchParams.get("method") as CompleteImportData["method"];
    const accountId = searchParams.get("accountId");

    if (method) {
      setCompleteImportData((prev) => ({ ...prev, method }));
      setCurrentStep("account");
    }

    if (accountId) {
      setCompleteImportData((prev) => ({
        ...prev,
        accountSelection: { mode: "select", selectedAccountId: accountId },
      }));
      setCurrentStep("data");
    }
  }, [searchParams]);

  // Update URL params when form data changes
  const updateCompleteImportData = useCallback(
    (updates: Partial<CompleteImportData>) => {
      setCompleteImportData((prev) => ({ ...prev, ...updates }));
    },
    []
  );

  // Sync URL params with complete import data
  useEffect(() => {
    const params = new URLSearchParams();
    if (completeImportData.method)
      params.set("method", completeImportData.method);
    if (completeImportData.accountSelection?.selectedAccountId)
      params.set(
        "accountId",
        completeImportData.accountSelection.selectedAccountId
      );

    setSearchParams(params);
  }, [
    completeImportData.method,
    completeImportData.accountSelection?.selectedAccountId,
    setSearchParams,
  ]);

  // Fetch data needed for progress bar display
  // Note: Account and institution data is handled by AccountSelectionStep

  const nextStep = useCallback(() => {
    if (currentStep === "method") setCurrentStep("account");
    else if (currentStep === "account") setCurrentStep("data");
  }, [currentStep]);

  const prevStep = useCallback(() => {
    if (currentStep === "data") {
      // Going back from data entry to account selection
      // Clear account selection from complete import data and URL
      setCompleteImportData((prev) => {
        const newData = { ...prev };
        delete newData.accountSelection;
        return newData;
      });

      setCurrentStep("account");
    } else if (currentStep === "account") {
      // Going back from account selection to method selection
      // Clear method and account selection from complete import data and URL
      setCompleteImportData({});
      setCurrentStep("method");
    }
  }, [currentStep]);
  const getStepNumber = (step: Step): number => {
    switch (step) {
      case "method":
        return 1;
      case "account":
        return 2;
      case "data":
        return 3;
    }
  };

  const getProgress = (): number => {
    return (getStepNumber(currentStep) / 3) * 100;
  };

  // Calculate valid holdings for button state and text
  const getValidHoldingsInfo = () => {
    const holdings = completeImportData.dataEntry?.holdings || [];
    const validHoldings = holdings.filter(
      (holding) => holding.tokenValue.trim() && holding.amount.trim()
    );
    const hasInvalidHoldings = holdings.some(
      (holding) => !holding.tokenValue.trim() || !holding.amount.trim()
    );

    // For existing accounts, also check if there are changes to existing holdings
    const hasExistingChanges =
      selectedAccountId &&
      completeImportData.accountSelection?.mode === "select"
        ? holdings.some(
            (h) =>
              h.isExisting &&
              h.amount !== h.originalAmount &&
              h.amount.trim() !== ""
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
    if (!completeImportData.method) return "Select Method";

    const methods = [
      { id: "manual", title: "Manual Entry" },
      { id: "screenshots", title: "Screenshots Upload" },
      { id: "wallet", title: "Cryptocurrency Wallet" },
    ];

    const selectedMethod = methods.find(
      (m) => m.id === completeImportData.method
    );
    return selectedMethod ? selectedMethod.title : "Select Method";
  };

  const getAccountDisplayText = (): string => {
    return accountDisplayText;
  };

  const handleAccountDisplayChange = useCallback((displayText: string) => {
    setAccountDisplayText(displayText);
  }, []);

  const completeWithNewAccount = useCallback(async () => {
    const accountSelection = completeImportData.accountSelection;

    if (!accountSelection || accountSelection.mode !== "create") {
      console.error("Account selection is not set to create mode");
      return;
    }

    const holdings = completeImportData.dataEntry?.holdings || [];

    const newAccountData = accountSelection.newAccountData;
    if (!newAccountData) {
      console.error("No new account data provided");
      return;
    }

    const newHoldingsToCreate = holdings.filter(
      (h) => !h.isExisting && h.tokenValue.trim() && h.amount.trim()
    );

    if (newHoldingsToCreate.length === 0) {
      console.error("No holdings to create");
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
            externalTokenData.provider === "coingecko"
              ? ("coingecko" as const)
              : ("finnhub" as const),
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
      const createdTokens = await createTokensFromExternalMutation.mutateAsync(
        externalTokensToCreate
      );

      // Map external token values to created token IDs
      createdTokensMap = createdTokens.reduce((acc, token) => {
        const externalValue = newHoldingsToCreate.find((h) => {
          const data = parseExternalTokenValue(h.tokenValue);
          return data?.symbol === token.symbol;
        })?.tokenValue;
        if (externalValue) {
          acc[externalValue] = token.id;
        }
        return acc;
      }, {} as Record<string, string>);
    }

    // Build processed holdings with created token IDs
    const processedHoldings = newHoldingsToCreate.map((holding) => ({
      tokenId: createdTokensMap[holding.tokenValue] || holding.tokenValue,
      balance: holding.amount,
    }));

    // Use unified batch operation to create institution (if needed), account, and ALL holdings atomically
    const result = await createHoldingsWithDependenciesMutation.mutateAsync({
      institution:
        newAccountData.institutionSelection?.mode === "create"
          ? {
              name:
                newAccountData.institutionSelection.newInstitutionData?.name ||
                "",
              typeId:
                newAccountData.institutionSelection.newInstitutionData
                  ?.typeId || "",
              description:
                newAccountData.institutionSelection.newInstitutionData
                  ?.description,
              website:
                newAccountData.institutionSelection.newInstitutionData?.website,
            }
          : undefined,
      account: {
        institutionId:
          newAccountData.institutionSelection?.selectedInstitutionId ||
          undefined,
        name: newAccountData.name,
        typeId: newAccountData.typeId,
      },
      holdings: processedHoldings,
    });

    console.log("Successfully created account and holdings");
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
      console.error("No account selected");
      return;
    }
    const holdings = completeImportData.dataEntry?.holdings || [];

    // Separate existing holdings that have changed from new holdings
    const existingHoldingsToUpdate = holdings.filter(
      (h) =>
        h.isExisting && h.amount !== h.originalAmount && h.amount.trim() !== ""
    );
    const newHoldingsToCreate = holdings.filter(
      (h) => !h.isExisting && h.tokenValue.trim() && h.amount.trim()
    );

    // Update existing holdings in batch
    if (existingHoldingsToUpdate.length > 0) {
      const holdingsToUpdate = existingHoldingsToUpdate
        .filter((h) => h.id.startsWith("existing-"))
        .map((holding) => ({
          id: holding.id.replace("existing-", ""),
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
              externalTokenData.provider === "coingecko"
                ? ("coingecko" as const)
                : ("finnhub" as const),
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
          await createTokensFromExternalMutation.mutateAsync(
            externalTokensToCreate
          );

        // Map external token values to created token IDs
        createdTokensMap = createdTokens.reduce((acc, token) => {
          const externalValue = newHoldingsToCreate.find((h) => {
            const data = parseExternalTokenValue(h.tokenValue);
            return data?.symbol === token.symbol;
          })?.tokenValue;
          if (externalValue) {
            acc[externalValue] = token.id;
          }
          return acc;
        }, {} as Record<string, string>);
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
      if (accountSelection?.mode === "create") {
        await completeWithNewAccount();
        return;
      }

      // Case 2: Using existing account - update existing holdings and/or create new ones
      await completeWithExistingAccount();
      console.log("Successfully updated and created holdings");

      // Redirect to account details page
      navigate(`/accounts/${accountId}`);
    } catch (error) {
      console.error("Failed to update/create holdings:", error);
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

      <PageHeader
        title="Add Data"
        subtitle="Import your financial data into Scani"
      />

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
              <span
                className={
                  currentStep === "method" ? "font-medium text-foreground" : ""
                }
              >
                1. {getMethodDisplayText()}
              </span>
              <span
                className={
                  currentStep === "account" ? "font-medium text-foreground" : ""
                }
              >
                2. {getAccountDisplayText()}
              </span>
              <span
                className={
                  currentStep === "data" ? "font-medium text-foreground" : ""
                }
              >
                3. Enter Data
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Step Content */}
      {currentStep === "method" && (
        <MethodSelectionStep
          completeImportData={completeImportData}
          onCompleteDataUpdate={updateCompleteImportData}
        />
      )}
      {currentStep === "account" && (
        <AccountSelectionStep
          onValidationChange={setIsAccountStepValid}
          onAccountDisplayChange={handleAccountDisplayChange}
          onCompleteDataUpdate={updateCompleteImportData}
        />
      )}
      {currentStep === "data" && (
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
              paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
            }}
          >
            <div className="flex justify-between max-w-screen-sm mx-auto">
              <Button
                variant="outline"
                onClick={prevStep}
                disabled={currentStep === "method"}
              >
                Back
              </Button>
              <Button
                onClick={async () => {
                  if (currentStep === "method" && completeImportData.method) {
                    nextStep();
                  } else if (currentStep === "account") {
                    // For account step, we can always proceed since account selection is optional
                    nextStep();
                  } else if (currentStep === "data") {
                    await complete();
                  }
                }}
                disabled={
                  (currentStep === "method" && !completeImportData.method) ||
                  (currentStep === "account" && !isAccountStepValid) ||
                  (currentStep === "data" &&
                    !getValidHoldingsInfo().hasChanges) ||
                  createTokenFromExternalMutation.isPending ||
                  createHoldingsWithDependenciesMutation.isPending ||
                  updateHoldingsBatchMutation.isPending ||
                  updateHoldingMutation.isPending
                }
              >
                {currentStep === "data" ? "Submit" : "Continue"}
              </Button>
            </div>
          </div>,
          navContainer
        )}
    </div>
  );
}

function MethodSelectionStep({
  completeImportData,
  onCompleteDataUpdate,
}: {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
}) {
  const methods = [
    {
      id: "manual" as const,
      title: "Manual Entry",
      description:
        "Manually enter your holdings, transactions, and account information",
      icon: "📝",
      disabled: false,
    },
    {
      id: "screenshots" as const,
      title: "Screenshots Upload",
      description:
        "Upload screenshots of your statements and let AI extract the data",
      icon: "📸",
      disabled: true,
    },
    {
      id: "wallet" as const,
      title: "Cryptocurrency Wallet",
      description:
        "Connect your crypto wallet to automatically import holdings",
      icon: "🔐",
      disabled: true,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>How would you like to add your data?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-1 lg:grid-cols-3">
          {methods.map((method) => (
            <Card
              key={method.id}
              className={`transition-all hover:shadow-md ${
                completeImportData.method === method.id
                  ? "ring-2 ring-primary"
                  : ""
              } ${
                method.disabled
                  ? "opacity-60 cursor-not-allowed"
                  : "cursor-pointer hover:shadow-md"
              }`}
              onClick={() => {
                if (!method.disabled) {
                  onCompleteDataUpdate({ method: method.id });
                }
              }}
            >
              <CardContent className="p-4 md:p-6 text-center relative">
                {method.disabled && (
                  <Badge
                    variant="secondary"
                    className="absolute top-2 right-2 bg-muted text-muted-foreground"
                  >
                    Coming Soon
                  </Badge>
                )}
                <div className="text-3xl md:text-4xl mb-2 md:mb-4">
                  {method.icon}
                </div>
                <h3 className="font-semibold mb-1 md:mb-2 text-sm md:text-base">
                  {method.title}
                </h3>
                <p className="text-xs md:text-sm text-muted-foreground">
                  {method.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AccountSelectionStep({
  onValidationChange,
  onAccountDisplayChange,
  onCompleteDataUpdate,
}: {
  onValidationChange?: (isValid: boolean) => void;
  onAccountDisplayChange?: (displayText: string) => void;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
}) {
  const [mode, setMode] = useState<"select" | "create">("select");
  const accountNameId = useId();
  const institutionNameId = useId();
  const institutionWebsiteId = useId();
  const institutionDescriptionId = useId();
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [newAccountData, setNewAccountData] = useState({
    name: "",
    typeId: "",
    institutionSelection: {
      mode: "select" as "select" | "create",
      selectedInstitutionId: "",
      newInstitutionData: {
        name: "",
        typeId: "",
        website: "",
        description: "",
      },
    },
  });
  const [, setInstitutionMetadata] = useState<{
    title: string;
    description: string;
    siteName: string;
  } | null>(null);
  const [hasFetchedMetadata, setHasFetchedMetadata] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Fetch data
  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  // Automatically switch to create mode if no accounts exist
  useEffect(() => {
    if (!accountsLoading && accounts && accounts.length === 0) {
      setMode("create");
    }
  }, [accountsLoading, accounts]);

  // Query for fetching Open Graph metadata (disabled by default, triggered manually)
  const metadataQuery = trpc.institutions.getOpenGraphMetadata.useQuery(
    { url: newAccountData.institutionSelection.newInstitutionData.website },
    {
      enabled: false, // Don't fetch automatically
      onSuccess: (data) => {
        setInstitutionMetadata(data);
        setHasFetchedMetadata(true);
        // Auto-populate fields with metadata if available
        if (
          data.title &&
          !newAccountData.institutionSelection.newInstitutionData.name
        ) {
          setNewAccountData((prev) => ({
            ...prev,
            institutionSelection: {
              ...prev.institutionSelection,
              newInstitutionData: {
                ...prev.institutionSelection.newInstitutionData,
                name: data.title,
              },
            },
          }));
        }
        if (
          data.description &&
          !newAccountData.institutionSelection.newInstitutionData.description
        ) {
          setNewAccountData((prev) => ({
            ...prev,
            institutionSelection: {
              ...prev.institutionSelection,
              newInstitutionData: {
                ...prev.institutionSelection.newInstitutionData,
                description: data.description,
              },
            },
          }));
        }
      },
    }
  );

  // Handler for fetching metadata from website
  const handleFetchMetadata = async () => {
    if (
      !newAccountData.institutionSelection.newInstitutionData.website.trim()
    ) {
      alert("Please enter a website URL first");
      return;
    }

    try {
      await metadataQuery.refetch();
    } catch (error) {
      console.error("Failed to fetch metadata:", error);
      // Even on error, show the form fields
      setHasFetchedMetadata(true);
    }
  };

  // Memoize validation values to prevent infinite re-renders
  const validationValues = useMemo(
    () => ({
      hasAccountDetails:
        newAccountData.name.trim() !== "" &&
        newAccountData.typeId.trim() !== "",
      hasInstitutionDetails:
        newAccountData.institutionSelection.mode === "select"
          ? newAccountData.institutionSelection.selectedInstitutionId.trim() !==
            ""
          : newAccountData.institutionSelection.newInstitutionData.name.trim() !==
              "" &&
            newAccountData.institutionSelection.newInstitutionData.typeId.trim() !==
              "",
    }),
    [
      newAccountData.name,
      newAccountData.typeId,
      newAccountData.institutionSelection.mode,
      newAccountData.institutionSelection.selectedInstitutionId,
      newAccountData.institutionSelection.newInstitutionData.name,
      newAccountData.institutionSelection.newInstitutionData.typeId,
    ]
  );

  // Validation function
  const isValidForContinue = useCallback(() => {
    if (mode === "select") {
      return selectedAccountId.trim() !== "";
    } else if (mode === "create") {
      if (!validationValues.hasAccountDetails) return false;
      return validationValues.hasInstitutionDetails;
    }
    return false;
  }, [mode, selectedAccountId, validationValues]);

  // Notify parent of validation changes
  useEffect(() => {
    onValidationChange?.(isValidForContinue());
  }, [onValidationChange, isValidForContinue]);

  // Memoize account data to prevent unnecessary re-renders
  const accountData = useMemo(() => {
    if (!isValidForContinue()) return null;

    return {
      mode,
      selectedAccountId: mode === "select" ? selectedAccountId : undefined,
      newAccountData: mode === "create" ? newAccountData : undefined,
    } as NonNullable<CompleteImportData["accountSelection"]>;
  }, [mode, selectedAccountId, newAccountData, isValidForContinue]);

  // Store complete account data when valid
  useEffect(() => {
    if (accountData) {
      onCompleteDataUpdate({ accountSelection: accountData });
    }
  }, [accountData, onCompleteDataUpdate]);

  // Update account display text for progress bar
  useEffect(() => {
    let displayText = "Choose Account";

    if (mode === "select" && selectedAccountId) {
      // Existing account selected
      const selectedAccount = accounts?.find(
        (acc) => acc.id === selectedAccountId
      );
      if (selectedAccount) {
        const institution = institutions?.find(
          (inst) => inst.id === selectedAccount.institutionId
        );
        const institutionName = institution?.name || "Unknown Institution";
        displayText = `${selectedAccount.name} (${institutionName})`;
      }
    } else if (mode === "create" && newAccountData.name.trim()) {
      // New account being created
      let institutionName = "New Institution";

      if (
        newAccountData.institutionSelection.mode === "select" &&
        newAccountData.institutionSelection.selectedInstitutionId
      ) {
        // Existing institution selected for new account
        const institution = institutions?.find(
          (inst) =>
            inst.id ===
            newAccountData.institutionSelection.selectedInstitutionId
        );
        institutionName = institution?.name || "Unknown Institution";
      } else if (
        newAccountData.institutionSelection.mode === "create" &&
        newAccountData.institutionSelection.newInstitutionData.name.trim()
      ) {
        // New institution being created
        institutionName =
          newAccountData.institutionSelection.newInstitutionData.name;
      }

      displayText = `${newAccountData.name} (${institutionName})`;
    }

    onAccountDisplayChange?.(displayText);
  }, [
    mode,
    selectedAccountId,
    newAccountData.name,
    newAccountData.institutionSelection.mode,
    newAccountData.institutionSelection.selectedInstitutionId,
    newAccountData.institutionSelection.newInstitutionData.name,
    accounts,
    institutions,
    onAccountDisplayChange,
  ]);

  const handleAccountSelect = (accountId: string) => {
    setSelectedAccountId(accountId);

    // Store complete account selection data
    onCompleteDataUpdate({
      accountSelection: {
        mode: "select",
        selectedAccountId: accountId,
      },
    });
  };

  // Filter accounts based on search term
  const filteredAccounts = accounts?.filter((account) => {
    if (!searchTerm.trim()) return true;

    const accountName = account.name.toLowerCase();
    const institution = institutions?.find(
      (inst) => inst.id === account.institutionId
    );
    const institutionName = institution?.name.toLowerCase() || "";

    const searchLower = searchTerm.toLowerCase();

    return (
      accountName.includes(searchLower) || institutionName.includes(searchLower)
    );
  });

  return (
    <div className="space-y-6">
      {/* Mode Selection */}
      <Card>
        <CardHeader>
          <CardTitle>Choose Account</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Card
              className={`cursor-pointer transition-all hover:shadow-md ${
                mode === "select" ? "ring-2 ring-primary" : ""
              }`}
              onClick={() => setMode("select")}
            >
              <CardContent className="p-4 md:p-6 text-center">
                <div className="text-2xl md:text-3xl mb-2 md:mb-4">📋</div>
                <h3 className="font-semibold mb-1 md:mb-2 text-sm md:text-base">
                  Select Existing Account
                </h3>
                <p className="text-xs md:text-sm text-muted-foreground">
                  Choose from your existing accounts
                </p>
              </CardContent>
            </Card>

            <Card
              className={`cursor-pointer transition-all hover:shadow-md ${
                mode === "create" ? "ring-2 ring-primary" : ""
              }`}
              onClick={() => setMode("create")}
            >
              <CardContent className="p-4 md:p-6 text-center">
                <div className="text-2xl md:text-3xl mb-2 md:mb-4">➕</div>
                <h3 className="font-semibold mb-1 md:mb-2 text-sm md:text-base">
                  Create New Account
                </h3>
                <p className="text-xs md:text-sm text-muted-foreground">
                  Set up a new account and institution
                </p>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      {/* Account Selection */}
      {mode === "select" && (
        <Card>
          <CardHeader>
            <CardTitle>Select Account</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Search Input - Show skeleton when loading */}
            <div className="mb-4">
              {accountsLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <Input
                  placeholder="Search accounts by name or institution..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              )}
            </div>

            {/* Account Grid - Show skeletons when loading */}
            {accountsLoading ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {["skeleton-1", "skeleton-2", "skeleton-3", "skeleton-4"].map(
                  (key) => (
                    <Card key={key}>
                      <CardContent className="p-4">
                        <Skeleton className="h-4 w-3/4 mb-2" />
                        <Skeleton className="h-3 w-1/2 mb-2" />
                        <Skeleton className="h-3 w-2/3" />
                      </CardContent>
                    </Card>
                  )
                )}
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredAccounts?.map((account) => {
                  const institution = institutions?.find(
                    (inst) => inst.id === account.institutionId
                  );
                  const accountType = accountTypes?.find(
                    (type) => type.id === account.typeId
                  );

                  return (
                    <Card
                      key={account.id}
                      className={`cursor-pointer transition-all hover:shadow-md ${
                        selectedAccountId === account.id
                          ? "ring-2 ring-primary"
                          : ""
                      }`}
                      onClick={() => handleAccountSelect(account.id)}
                    >
                      <CardContent className="p-4">
                        <h4 className="font-medium mb-1">{account.name}</h4>
                        <p className="text-sm text-muted-foreground mb-2">
                          {accountType?.name || "Unknown Type"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {institution?.name || "Unknown Institution"}
                        </p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Empty state - Only show when not loading and no accounts */}
            {!accountsLoading &&
              (!filteredAccounts || filteredAccounts.length === 0) && (
                <div className="text-center py-8 text-muted-foreground">
                  {searchTerm.trim() ? (
                    <p>No accounts found matching "{searchTerm}".</p>
                  ) : (
                    <p>
                      No accounts found. Try creating a new account instead.
                    </p>
                  )}
                </div>
              )}
          </CardContent>
        </Card>
      )}

      {/* Account Creation */}
      {mode === "create" && (
        <div className="space-y-6">
          {/* Account Details */}
          <Card>
            <CardHeader>
              <CardTitle>Account Information</CardTitle>
              <p className="text-sm text-muted-foreground">
                Provide details for your new account
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="account-name">Account Name *</Label>
                  <Input
                    id={accountNameId}
                    placeholder="e.g., Primary Checking, Retirement Portfolio"
                    value={newAccountData.name}
                    onChange={(e) =>
                      setNewAccountData((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Choose a descriptive name for this account
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="account-type">Account Type *</Label>
                  <AccountTypeSelector
                    value={newAccountData.typeId}
                    onValueChange={(value) =>
                      setNewAccountData((prev) => ({ ...prev, typeId: value }))
                    }
                    accountTypes={accountTypes}
                    placeholder="Select account type"
                    allowCreate={false}
                  />
                  <p className="text-xs text-muted-foreground">
                    What kind of account is this?
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Institution Selection */}
          <Card>
            <CardHeader>
              <CardTitle>Institution</CardTitle>
              <p className="text-sm text-muted-foreground">
                Where is this account held?
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Institution Mode Selection */}
              <div className="grid gap-4 md:grid-cols-2">
                <Card
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    newAccountData.institutionSelection.mode === "select"
                      ? "ring-2 ring-primary"
                      : ""
                  }`}
                  onClick={() => {
                    setNewAccountData((prev) => ({
                      ...prev,
                      institutionSelection: {
                        ...prev.institutionSelection,
                        mode: "select",
                        selectedInstitutionId: "",
                        newInstitutionData: {
                          name: "",
                          typeId: "",
                          website: "",
                          description: "",
                        },
                      },
                    }));
                  }}
                >
                  <CardContent className="p-4 md:p-6 text-center">
                    <div className="text-3xl md:text-4xl mb-4">🏦</div>
                    <h3 className="font-semibold mb-2 text-sm md:text-base">
                      Select Existing Institution
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Choose from your previously added institutions
                    </p>
                  </CardContent>
                </Card>

                <Card
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    newAccountData.institutionSelection.mode === "create"
                      ? "ring-2 ring-primary"
                      : ""
                  }`}
                  onClick={() => {
                    setNewAccountData((prev) => ({
                      ...prev,
                      institutionSelection: {
                        ...prev.institutionSelection,
                        mode: "create",
                        selectedInstitutionId: "",
                        newInstitutionData: {
                          name: "",
                          typeId: "",
                          website: "",
                          description: "",
                        },
                      },
                    }));
                  }}
                >
                  <CardContent className="p-4 md:p-6 text-center">
                    <div className="text-3xl md:text-4xl mb-4">🏗️</div>
                    <h3 className="font-semibold mb-2 text-sm md:text-base">
                      Create New Institution
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Add a new bank, broker, or financial institution
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* Institution Selection Form */}
              {newAccountData.institutionSelection.mode === "select" && (
                <div className="space-y-3">
                  <Label className="text-base font-medium">
                    Choose Institution
                  </Label>
                  <InstitutionSelector
                    value={
                      newAccountData.institutionSelection.selectedInstitutionId
                    }
                    onValueChange={(value) =>
                      setNewAccountData((prev) => ({
                        ...prev,
                        institutionSelection: {
                          ...prev.institutionSelection,
                          selectedInstitutionId: value,
                        },
                      }))
                    }
                    institutions={institutions}
                    placeholder="Select an institution"
                    allowCreate={false}
                  />
                  {(!institutions || institutions.length === 0) && (
                    <p className="text-sm text-muted-foreground">
                      No institutions found. Try creating a new institution
                      instead.
                    </p>
                  )}
                </div>
              )}

              {/* New Institution Creation Form */}
              {newAccountData.institutionSelection.mode === "create" && (
                <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
                  <div className="space-y-2">
                    <Label className="text-base font-medium">
                      Institution Details
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Provide information about the new institution
                    </p>
                  </div>

                  {/* Website Field - Always visible */}
                  <div className="space-y-2">
                    <Label htmlFor={institutionWebsiteId}>
                      Institution Website
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={institutionWebsiteId}
                        type="url"
                        placeholder="https://www.example.com"
                        value={
                          newAccountData.institutionSelection.newInstitutionData
                            .website
                        }
                        onChange={(e) =>
                          setNewAccountData((prev) => ({
                            ...prev,
                            institutionSelection: {
                              ...prev.institutionSelection,
                              newInstitutionData: {
                                ...prev.institutionSelection.newInstitutionData,
                                website: e.target.value,
                              },
                            },
                          }))
                        }
                        disabled={metadataQuery.isFetching}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleFetchMetadata}
                        disabled={
                          !newAccountData.institutionSelection.newInstitutionData.website.trim() ||
                          metadataQuery.isFetching
                        }
                        className="h-10"
                      >
                        {metadataQuery.isFetching
                          ? "Fetching..."
                          : "Fetch Info"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Enter the institution's website to automatically fetch
                      information
                    </p>
                  </div>

                  {/* Additional fields - Show after fetching metadata or when hasFetchedMetadata is true */}
                  {(hasFetchedMetadata || metadataQuery.isFetching) && (
                    <>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor={institutionNameId}>
                            Institution Name *
                          </Label>
                          <Input
                            id={institutionNameId}
                            placeholder="e.g., Chase Bank, Fidelity Investments"
                            value={
                              newAccountData.institutionSelection
                                .newInstitutionData.name
                            }
                            onChange={(e) =>
                              setNewAccountData((prev) => ({
                                ...prev,
                                institutionSelection: {
                                  ...prev.institutionSelection,
                                  newInstitutionData: {
                                    ...prev.institutionSelection
                                      .newInstitutionData,
                                    name: e.target.value,
                                  },
                                },
                              }))
                            }
                            disabled={metadataQuery.isFetching}
                          />
                          <p className="text-xs text-muted-foreground">
                            Full name of the financial institution
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="new-institution-type">
                            Institution Type *
                          </Label>
                          <InstitutionTypeSelector
                            value={
                              newAccountData.institutionSelection
                                .newInstitutionData.typeId
                            }
                            onValueChange={(value) =>
                              setNewAccountData((prev) => ({
                                ...prev,
                                institutionSelection: {
                                  ...prev.institutionSelection,
                                  newInstitutionData: {
                                    ...prev.institutionSelection
                                      .newInstitutionData,
                                    typeId: value,
                                  },
                                },
                              }))
                            }
                            institutionTypes={institutionTypes}
                            placeholder="Select type"
                            allowCreate={false}
                            disabled={metadataQuery.isFetching}
                          />
                          <p className="text-xs text-muted-foreground">
                            Bank, investment firm, crypto exchange, etc.
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={institutionDescriptionId}>
                          Description
                        </Label>
                        <Input
                          id={institutionDescriptionId}
                          placeholder="Brief description of the institution"
                          value={
                            newAccountData.institutionSelection
                              .newInstitutionData.description
                          }
                          onChange={(e) =>
                            setNewAccountData((prev) => ({
                              ...prev,
                              institutionSelection: {
                                ...prev.institutionSelection,
                                newInstitutionData: {
                                  ...prev.institutionSelection
                                    .newInstitutionData,
                                  description: e.target.value,
                                },
                              },
                            }))
                          }
                          disabled={metadataQuery.isFetching}
                        />
                        <p className="text-xs text-muted-foreground">
                          Optional description of the institution's services
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function DataEntryStep({
  completeImportData,
  onCompleteDataUpdate,
  isCreatingHoldings,
  onChangesDetected,
}: {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  isCreatingHoldings: boolean;
  onChangesDetected?: (hasChanges: boolean) => void;
}) {
  // Fetch existing holdings for the selected account
  const selectedAccountId =
    completeImportData.accountSelection?.selectedAccountId;
  const { data: allHoldings, isLoading: isLoadingHoldings } =
    trpc.holdings.getWithDetails.useQuery(undefined, {
      enabled:
        !!selectedAccountId &&
        completeImportData.accountSelection?.mode === "select",
    });

  // Filter holdings for the selected account
  const existingHoldings =
    allHoldings?.filter(
      (holding) => holding.account.id === selectedAccountId
    ) || [];

  // Initialize holdings data when account changes
  const holdings = useMemo(() => {
    const currentHoldings = completeImportData.dataEntry?.holdings || [];

    // If we have an existing account selected and no holdings initialized yet, and query has completed
    if (
      selectedAccountId &&
      completeImportData.accountSelection?.mode === "select" &&
      currentHoldings.length < 2 &&
      !isLoadingHoldings
    ) {
      // Initialize with existing holdings
      const initializedHoldings = existingHoldings.map((holding) => ({
        id: `existing-${holding.id}`,
        tokenValue: holding.token.id,
        amount: holding.amount.toString(),
        isExisting: true,
        originalAmount: holding.amount.toString(),
      }));

      // Add one empty new holding
      initializedHoldings.push({
        id: `new-${Date.now()}-initial`,
        tokenValue: "",
        amount: "",
        isExisting: false,
        originalAmount: "",
      });

      return initializedHoldings;
    }

    // For new accounts or when holdings are already initialized
    if (currentHoldings.length === 0) {
      return [
        {
          id: `new-${Date.now()}-initial`,
          tokenValue: "",
          amount: "",
          isExisting: false,
          originalAmount: "",
        },
      ];
    }

    return currentHoldings;
  }, [
    selectedAccountId,
    completeImportData.accountSelection?.mode,
    completeImportData.dataEntry?.holdings,
    existingHoldings,
    isLoadingHoldings,
  ]);

  // Update holdings in state when they change
  useEffect(() => {
    if (holdings !== completeImportData.dataEntry?.holdings) {
      onCompleteDataUpdate({
        dataEntry: {
          ...completeImportData.dataEntry,
          holdings,
        },
      });
    }
  }, [holdings, completeImportData.dataEntry, onCompleteDataUpdate]);

  // Check if there are any changes to existing holdings or new holdings added
  const hasChanges = useMemo(() => {
    const newHoldings = holdings.filter((h) => !h.isExisting);
    const existingHoldings = holdings.filter((h) => h.isExisting);

    // Check if any new holdings have data
    const hasNewHoldings = newHoldings.some(
      (h) => h.tokenValue.trim() && h.amount.trim()
    );

    // Check if any existing holdings have changed
    const hasExistingChanges = existingHoldings.some(
      (h) => h.amount !== h.originalAmount && h.amount.trim() !== ""
    );

    return hasNewHoldings || hasExistingChanges;
  }, [holdings]);

  // Notify parent of changes
  useEffect(() => {
    onChangesDetected?.(hasChanges);
  }, [hasChanges, onChangesDetected]);

  const addHolding = useCallback(() => {
    const newHoldings = [
      ...holdings,
      {
        id: `new-${Date.now()}-${Math.random()}`,
        tokenValue: "",
        amount: "",
        isExisting: false,
      },
    ];
    onCompleteDataUpdate({
      dataEntry: {
        ...completeImportData.dataEntry,
        holdings: newHoldings,
      },
    });
  }, [holdings, completeImportData.dataEntry, onCompleteDataUpdate]);

  const removeHolding = useCallback(
    (id: string) => {
      const newHoldings = holdings.filter((h) => h.id !== id);
      onCompleteDataUpdate({
        dataEntry: {
          ...completeImportData.dataEntry,
          holdings: newHoldings,
        },
      });
    },
    [holdings, completeImportData.dataEntry, onCompleteDataUpdate]
  );

  const updateHolding = useCallback(
    (id: string, field: "tokenValue" | "amount", value: string) => {
      const newHoldings = holdings.map((h) =>
        h.id === id ? { ...h, [field]: value } : h
      );
      onCompleteDataUpdate({
        dataEntry: {
          ...completeImportData.dataEntry,
          holdings: newHoldings,
        },
      });
    },
    [holdings, completeImportData.dataEntry, onCompleteDataUpdate]
  );

  const renderDataEntryForm = () => {
    const existingHoldingsList = holdings.filter((h) => h.isExisting);
    const newHoldingsList = holdings.filter((h) => !h.isExisting);

    switch (completeImportData.method) {
      case "manual":
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h3 className="text-lg font-semibold mb-2">Manual Data Entry</h3>
              <p className="text-muted-foreground">
                {selectedAccountId &&
                completeImportData.accountSelection?.mode === "select"
                  ? "Edit existing holdings or add new ones to your account."
                  : "Add holdings to your account by selecting tokens and entering amounts."}
              </p>
            </div>

            {/* Existing Holdings Section */}
            {existingHoldingsList.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span>Existing Holdings</span>
                    <Badge variant="secondary">
                      {existingHoldingsList.length}
                    </Badge>
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Edit the amounts of your existing holdings
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {existingHoldingsList.map((holding) => {
                    const hasChanged =
                      holding.amount !== holding.originalAmount &&
                      holding.amount.trim() !== "";
                    return (
                      <div
                        key={holding.id}
                        className="flex flex-col md:flex-row gap-4 md:items-end"
                      >
                        <div className="flex-1">
                          <Label htmlFor={`token-${holding.id}`}>Token</Label>
                          <TokenSearchableSelector
                            value={holding.tokenValue}
                            onValueChange={(value) =>
                              updateHolding(holding.id, "tokenValue", value)
                            }
                            // className="max-w-[calc(100%-8rem)]"
                            placeholder="Search tokens..."
                            disabled={isCreatingHoldings || true} // Disable token changes for existing holdings
                            allowCreateNew={false}
                          />
                        </div>
                        <div className="w-32">
                          <Label htmlFor={`amount-${holding.id}`}>Amount</Label>
                          <Input
                            id={`amount-${holding.id}`}
                            type="number"
                            step="any"
                            value={holding.amount}
                            onChange={(e) =>
                              updateHolding(
                                holding.id,
                                "amount",
                                e.target.value
                              )
                            }
                            placeholder="0.00"
                            disabled={isCreatingHoldings}
                            className={hasChanged ? "border-blue-500" : ""}
                          />
                        </div>
                        {hasChanged && (
                          <Badge
                            variant="outline"
                            className="text-blue-600 border-blue-500"
                          >
                            Modified
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            {/* New Holdings Section */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span>Add New Holdings</span>
                  {newHoldingsList.length > 0 && (
                    <Badge variant="secondary">{newHoldingsList.length}</Badge>
                  )}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Add additional holdings to your account
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {newHoldingsList.map((holding) => (
                  <div
                    key={holding.id}
                    className="flex flex-col md:flex-row gap-4 md:items-end"
                  >
                    <div className="flex-1">
                      <Label htmlFor={`token-${holding.id}`}>Token</Label>
                      <TokenSearchableSelector
                        value={holding.tokenValue}
                        onValueChange={(value) =>
                          updateHolding(holding.id, "tokenValue", value)
                        }
                        // className="max-w-[calc(100%-8rem)]"
                        placeholder="Search tokens..."
                        disabled={isCreatingHoldings}
                        allowCreateNew={false}
                      />
                    </div>
                    <div className="w-32">
                      <Label htmlFor={`amount-${holding.id}`}>Amount</Label>
                      <Input
                        id={`amount-${holding.id}`}
                        type="number"
                        step="any"
                        value={holding.amount}
                        onChange={(e) =>
                          updateHolding(holding.id, "amount", e.target.value)
                        }
                        placeholder="0.00"
                        disabled={isCreatingHoldings}
                      />
                    </div>
                    {newHoldingsList.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => removeHolding(holding.id)}
                        disabled={isCreatingHoldings}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addHolding}
                    disabled={isCreatingHoldings}
                  >
                    Add Another Holding
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        );

      case "screenshots":
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h3 className="text-lg font-semibold mb-2">Screenshot Upload</h3>
              <p className="text-muted-foreground">
                Upload screenshots of your financial statements and we'll
                extract the data automatically.
              </p>
            </div>

            {/* TODO: Implement screenshot upload */}
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <p>Screenshot upload and parsing coming soon...</p>
                <p className="text-sm mt-2">
                  This will use AI to extract data from images.
                </p>
              </CardContent>
            </Card>
          </div>
        );

      case "wallet":
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h3 className="text-lg font-semibold mb-2">
                Cryptocurrency Wallet Import
              </h3>
              <p className="text-muted-foreground">
                Connect your cryptocurrency wallet to automatically import your
                holdings and transaction history.
              </p>
            </div>

            {/* TODO: Implement wallet import */}
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <p>Wallet import functionality coming soon...</p>
                <p className="text-sm mt-2">
                  This will support ERC20 tokens, wallet addresses, etc.
                </p>
              </CardContent>
            </Card>
          </div>
        );

      default:
        return (
          <div className="text-center py-12 text-muted-foreground">
            <p>Please select a data import method first.</p>
          </div>
        );
    }
  };

  return <div className="space-y-6">{renderDataEntryForm()}</div>;
}
