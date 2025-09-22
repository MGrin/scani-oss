import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Camera, Info, PenTool, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { AsyncTokenSelector } from "@/components/AsyncTokenSelector";
import { ScreenshotUpload } from "@/components/ScreenshotUpload";
import {
  AccountSelector,
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from "@/components/selectors/SearchableSelectors";
import { TokenForm } from "@/components/TokenForm";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingSpinner } from "@/components/ui/loading";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  type ParsedHolding,
  useScreenshotParsing,
} from "@/hooks/useScreenshotParsing";
import { trpc } from "@/lib/trpc";

// Schema for the form with improved validation
const QuickAddHoldingSchema = z
  .object({
    // Holding fields - Keep as number in frontend, convert to string for backend
    balance: z
      .number({
        required_error: "Balance is required",
        invalid_type_error: "Balance must be a valid number",
      })
      .refine((val) => !Number.isNaN(val), "Balance must be a valid number")
      .refine(
        (val) => val !== 0,
        "Balance cannot be zero. Enter the actual holding amount."
      )
      .refine(
        (val) => Math.abs(val) >= 0.000001,
        "Balance is too small. Minimum value is 0.000001"
      )
      .refine(
        (val) => Math.abs(val) <= 1_000_000_000,
        "Balance is too large. Maximum value is 1 billion"
      ),

    // Account selection
    accountId: z.string().min(1, "Please select an account"),

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
    tokenId: z.string().min(1, "Please select a token"),
  })
  .superRefine((data, ctx) => {
    // Validate new account fields when creating new account
    if (data.accountId === "new") {
      if (!data.newAccountName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Account name is required when creating a new account",
          path: ["newAccountName"],
        });
      }

      if (!data.newAccountType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Account type is required when creating a new account",
          path: ["newAccountType"],
        });
      }

      if (!data.institutionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Institution is required when creating a new account",
          path: ["institutionId"],
        });
      }

      // Validate new institution fields when creating new institution
      if (data.institutionId === "new") {
        if (!data.newInstitutionName?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Institution name is required when creating a new institution",
            path: ["newInstitutionName"],
          });
        }

        if (!data.newInstitutionType) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Institution type is required when creating a new institution",
            path: ["newInstitutionType"],
          });
        }
      }
    }
  });

type QuickAddHoldingData = z.infer<typeof QuickAddHoldingSchema>;

// Step definitions
type WorkflowStep =
  | "account-selection"
  | "entry-method"
  | "manual-entry"
  | "screenshot-entry";

export function QuickAddHolding() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTokenFormOpen, setIsTokenFormOpen] = useState(false);

  // Get pre-selected account from URL params
  const preSelectedAccountId = searchParams.get("accountId");

  // State for manually selected account (when going through account selection step)
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    preSelectedAccountId || ""
  );

  // Step management - skip account selection if account is pre-selected
  const [currentStep, setCurrentStep] = useState<WorkflowStep>(() => {
    return preSelectedAccountId ? "entry-method" : "account-selection";
  });

  // Screenshot parsing hook
  const screenshotParsing = useScreenshotParsing({
    allowMultiple: true,
    onSuccess: () => {
      toast({
        title: "Success!",
        description: "Holdings have been successfully added to your account.",
      });
      navigate("/holdings");
    },
    onMultipleParsingComplete: (result) => {
      // Handle multiple screenshot results - use combined holdings
      if (result.combinedHoldings) {
        setEditableHoldings(result.combinedHoldings);
      }
    },
  });

  // State for editable holdings from screenshot
  const [editableHoldings, setEditableHoldings] = useState<ParsedHolding[]>([]);
  const [editingHoldingIds, setEditingHoldingIds] = useState<Set<number>>(
    new Set()
  );
  // Track token selection for each editable holding by index
  const [editableHoldingTokenIds, setEditableHoldingTokenIds] = useState<
    Record<number, string>
  >({});

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

      setEditableHoldings(sortedHoldings);

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
  }, [screenshotParsing.parsingResults, screenshotParsing.multipleResults]);

  // Form IDs
  const balanceId = useId();
  const accountSelectId = useId();
  const tokenSelectId = useId();
  const institutionSelectId = useId();

  // Data queries
  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.getAll.useQuery();

  // Get currently selected account (either from URL params or manual selection)
  const currentlySelectedAccountId = preSelectedAccountId || selectedAccountId;
  const currentlySelectedAccount = accounts?.find(
    (acc) => acc.id === currentlySelectedAccountId
  );
  const { data: institutions, isLoading: institutionsLoading } =
    trpc.institutions.getAll.useQuery();

  const { data: accountTypes, isLoading: accountTypesLoading } =
    trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes, isLoading: institutionTypesLoading } =
    trpc.institutionTypes.getAll.useQuery();

  // Get existing holdings for the selected account to show create/update status
  const { data: allHoldings } = trpc.holdings.getAll.useQuery(undefined, {
    enabled:
      !!currentlySelectedAccountId &&
      (currentStep === "screenshot-entry" || currentStep === "manual-entry"),
  });

  // Get tokens to match symbols with token data
  const { data: allTokens } = trpc.tokens.getAll.useQuery(undefined, {
    enabled:
      !!currentlySelectedAccountId &&
      (currentStep === "screenshot-entry" || currentStep === "manual-entry"),
  });

  // Filter holdings for current account and add token info
  const existingHoldings = useMemo(() => {
    if (!allHoldings || !allTokens || !currentlySelectedAccountId) return [];

    return allHoldings
      .filter((h) => h.accountId === currentlySelectedAccountId)
      .map((h) => {
        const token = allTokens.find((t) => t.id === h.tokenId);
        return { ...h, token };
      });
  }, [allHoldings, allTokens, currentlySelectedAccountId]);

  const utils = trpc.useUtils();

  // Mutations
  const createInstitution = trpc.institutions.create.useMutation();
  const createAccount = trpc.accounts.create.useMutation();
  const createTokenFromExternal = trpc.tokens.createFromExternal.useMutation();

  const createHolding = trpc.holdings.create.useMutation();

  const form = useForm<QuickAddHoldingData>({
    resolver: zodResolver(QuickAddHoldingSchema),
    mode: "onChange", // Validate on change for better UX
    reValidateMode: "onChange",
    defaultValues: {
      accountId: preSelectedAccountId || "",
    },
  });

  // Helper functions for editable holdings
  const updateHolding = (index: number, updates: Partial<ParsedHolding>) => {
    setEditableHoldings((prev) =>
      prev.map((holding, i) =>
        i === index ? { ...holding, ...updates } : holding
      )
    );
  };

  // Synchronize token selections with holdings before processing
  const synchronizeTokenSelections = useCallback((): ParsedHolding[] => {
    return editableHoldings.map((holding, index) => {
      const selectedTokenId = editableHoldingTokenIds[index];

      // Validate required fields
      if (!holding.symbol || holding.symbol.trim() === "") {
        return {
          ...holding,
          errors: [...holding.errors, "Symbol is required"],
        };
      }

      if (
        !holding.balance ||
        holding.balance.trim() === "" ||
        parseFloat(holding.balance) <= 0
      ) {
        return {
          ...holding,
          errors: [...holding.errors, "Valid balance amount is required"],
        };
      }

      if (selectedTokenId && selectedTokenId !== holding.tokenId) {
        // Handle different types of token selections
        if (selectedTokenId.startsWith("external:")) {
          // External token - needs to be created, don't set tokenId
          try {
            const parts = selectedTokenId.split(":");
            const metadata = JSON.parse(parts.slice(2).join(":"));
            console.log("Synchronizing external token metadata:", metadata);

            return {
              ...holding,
              symbol: metadata.symbol,
              name: metadata.name,
              tokenExists: false, // Will be created by backend
              requiresUserSelection: false,
              errors: holding.errors.filter(
                (err) =>
                  !err.includes("User selection required") &&
                  !err.includes("Token not found")
              ),
              // Set provider validation for backend token creation
              providerValidation: {
                exactMatch: {
                  isValid: true,
                  metadata: {
                    ...metadata,
                    type: metadata.type || "Equity", // Ensure type is always present
                  },
                },
              },
              suggestedTokenType: metadata.type || "other",
            };
          } catch (error) {
            console.error("Failed to parse external token metadata:", error);
            return {
              ...holding,
              tokenExists: false,
              errors: [
                ...holding.errors,
                "Failed to parse selected token metadata",
              ],
            };
          }
        } else {
          // Existing token with valid UUID
          return {
            ...holding,
            tokenId: selectedTokenId,
            tokenExists: true,
            errors: holding.errors.filter(
              (err) =>
                !err.includes("User selection required") &&
                !err.includes("Token not found")
            ),
            requiresUserSelection: false,
          };
        }
      }
      return holding;
    });
  }, [editableHoldings, editableHoldingTokenIds]);

  const deleteHolding = (index: number) => {
    setEditableHoldings((prev) => prev.filter((_, i) => i !== index));
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
    const newHolding: ParsedHolding = {
      symbol: "",
      name: "",
      balance: "",
      confidence: 1,
      tokenExists: false,
      errors: [],
      warnings: [],
    };
    setEditableHoldings((prev) => [...prev, newHolding]);
  };

  // Helper functions for per-row edit mode
  const toggleEditMode = (index: number) => {
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

  const getHoldingStatus = (holding: ParsedHolding) => {
    if (!existingHoldings || !currentlySelectedAccountId) return "create";

    const existingHolding = existingHoldings.find(
      (h) =>
        h.accountId === currentlySelectedAccountId &&
        h.token?.symbol?.toLowerCase() === holding.symbol.toLowerCase()
    );

    if (existingHolding) {
      const currentBalance = Number.parseFloat(existingHolding.balance);
      const newBalance = Number.parseFloat(holding.balance);
      const difference = newBalance - currentBalance;

      return {
        type: "update" as const,
        currentBalance: existingHolding.balance,
        difference: difference.toString(),
        isIncrease: difference > 0,
      };
    }

    return { type: "create" as const };
  };

  // Step navigation functions

  const handleEntryMethodSelected = (method: "manual" | "screenshot") => {
    if (method === "manual") {
      setCurrentStep("manual-entry");
    } else {
      setCurrentStep("screenshot-entry");
    }
  };

  const goBack = () => {
    switch (currentStep) {
      case "entry-method":
        if (preSelectedAccountId) {
          navigate(-1); // Go back to where we came from
        } else {
          setCurrentStep("account-selection");
        }
        break;
      case "manual-entry":
      case "screenshot-entry":
        setCurrentStep("entry-method");
        break;
      default:
        navigate(-1);
    }
  };

  // Watch for account changes to update selected account state
  const watchedAccountId = form.watch("accountId");
  useEffect(() => {
    if (watchedAccountId && watchedAccountId !== preSelectedAccountId) {
      setSelectedAccountId(watchedAccountId);
    }
  }, [watchedAccountId, preSelectedAccountId]);

  const watchAccountId = form.watch("accountId");
  const watchInstitutionId = form.watch("institutionId");

  // Watch all form values for reactive validation
  const formValues = form.watch();

  // Custom validation to check if only required fields are filled
  const isFormValidForSubmission = useMemo(() => {
    const errors = form.formState.errors;

    // Check core required fields
    if (!formValues.accountId || errors.accountId) return false;
    if (!formValues.tokenId || errors.tokenId) return false;
    if (
      formValues.balance === undefined ||
      formValues.balance === null ||
      errors.balance
    )
      return false;

    // If creating new account, check required account fields
    if (formValues.accountId === "new") {
      if (!formValues.newAccountName?.trim() || errors.newAccountName)
        return false;
      if (!formValues.newAccountType || errors.newAccountType) return false;
      if (!formValues.institutionId || errors.institutionId) return false;

      // If creating new institution, check required institution fields
      if (formValues.institutionId === "new") {
        if (!formValues.newInstitutionName?.trim() || errors.newInstitutionName)
          return false;
        if (!formValues.newInstitutionType || errors.newInstitutionType)
          return false;
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
    if (accountId !== "new") return true;

    // If creating new account, check required fields
    if (!formValues.newAccountName?.trim() || errors.newAccountName)
      return false;
    if (!formValues.newAccountType || errors.newAccountType) return false;
    if (!formValues.institutionId || errors.institutionId) return false;

    // If creating new institution, check required institution fields
    if (formValues.institutionId === "new") {
      if (!formValues.newInstitutionName?.trim() || errors.newInstitutionName)
        return false;
      if (!formValues.newInstitutionType || errors.newInstitutionType)
        return false;
    }

    return true;
  }, [formValues, form.formState.errors, selectedAccountId]);

  // Set default values based on available data
  useEffect(() => {
    if (!accountsLoading && accounts !== undefined && !watchAccountId) {
      if (!accounts || accounts.length === 0) {
        form.setValue("accountId", "new");
      } else {
        // Default to the first available account
        form.setValue("accountId", accounts[0]?.id || "new");
      }
    }
  }, [accounts, accountsLoading, form, watchAccountId]);

  useEffect(() => {
    if (
      !institutionsLoading &&
      institutions !== undefined &&
      watchAccountId === "new" &&
      !watchInstitutionId
    ) {
      // Get institutions where the user has accounts
      const userInstitutionIds = new Set(
        accounts?.map((account) => account.institutionId) || []
      );
      const userInstitutions =
        institutions?.filter((inst) => userInstitutionIds.has(inst.id)) || [];

      if (userInstitutions.length > 0) {
        // Default to the first institution where the user has accounts
        form.setValue("institutionId", userInstitutions[0]!.id);
      } else if (institutions && institutions.length > 0) {
        // If no user institutions, default to the first available institution
        form.setValue("institutionId", institutions[0]!.id);
      } else {
        // No institutions available, default to "new"
        form.setValue("institutionId", "new");
      }
    }
  }, [
    accounts,
    institutions,
    institutionsLoading,
    form,
    watchInstitutionId,
    watchAccountId,
  ]);

  // Note: Token auto-selection removed - AsyncTokenSelector handles its own defaults

  // Handle account creation when moving from account selection to next step
  const handleAccountCreation = async () => {
    const formData = form.getValues();
    const accountId = formData.accountId || selectedAccountId;

    if (accountId !== "new") {
      // Existing account selected, no need to create
      return accountId;
    }

    try {
      let institutionId = formData.institutionId;

      // Step 1: Create institution if needed
      if (institutionId === "new") {
        console.log("Creating institution:", {
          name: formData.newInstitutionName,
          type: formData.newInstitutionType,
          description: formData.newInstitutionDescription || "",
          website: formData.newInstitutionWebsite || "",
        });

        const newInstitution = await createInstitution.mutateAsync({
          name: formData.newInstitutionName!.trim(),
          type: formData.newInstitutionType!,
          description: formData.newInstitutionDescription?.trim() || "",
          website: formData.newInstitutionWebsite?.trim() || "",
        });

        if (!newInstitution?.id) {
          throw new Error("Failed to create institution - no ID returned");
        }

        institutionId = newInstitution.id;
        console.log("Institution created successfully:", institutionId);
      }

      // Step 2: Create account
      console.log("Creating account:", {
        name: formData.newAccountName,
        type: formData.newAccountType,
        institutionId: institutionId,
        description: formData.newAccountDescription || "",
      });

      const newAccount = await createAccount.mutateAsync({
        name: formData.newAccountName!.trim(),
        type: formData.newAccountType!,
        institutionId: institutionId!,
        description: formData.newAccountDescription?.trim() || "",
      });

      if (!newAccount?.id) {
        throw new Error("Failed to create account - no ID returned");
      }

      // Update form and state with the new account ID
      form.setValue("accountId", newAccount.id);
      setSelectedAccountId(newAccount.id);

      toast({
        title: "✅ Account Created",
        description: `Account "${newAccount.name}" has been successfully created.`,
      });

      return newAccount.id;
    } catch (error) {
      console.error("Account creation failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      toast({
        title: "❌ Failed to Create Account",
        description: errorMessage,
        variant: "destructive",
      });

      throw error;
    }
  };

  const onSubmit = async (data: QuickAddHoldingData) => {
    setIsSubmitting(true);

    try {
      // Use form accountId or fallback to currently selected account
      let accountId = data.accountId || currentlySelectedAccountId;
      let tokenId = data.tokenId;
      let institutionId = data.institutionId;

      console.log(
        "Form submission - accountId:",
        accountId,
        "currentlySelectedAccountId:",
        currentlySelectedAccountId
      );

      // Handle external token creation if needed
      if (tokenId.startsWith("external:")) {
        try {
          const parts = tokenId.split(":");
          const externalTokenData = JSON.parse(parts.slice(2).join(":"));

          console.log("Creating external token:", externalTokenData);

          const newToken = await createTokenFromExternal.mutateAsync({
            symbol: externalTokenData.symbol,
            provider: externalTokenData.provider,
            metadata: {
              ...externalTokenData.metadata,
              name: externalTokenData.name,
            },
          });

          tokenId = newToken.id;
          console.log("External token created successfully:", tokenId);
        } catch (error) {
          console.error("External token creation failed:", error);
          throw new Error(
            `Failed to create token: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      // Step 1: Create institution if needed
      if (accountId === "new" && data.institutionId === "new") {
        try {
          console.log("Creating institution:", {
            name: data.newInstitutionName,
            type: data.newInstitutionType,
            description: data.newInstitutionDescription || "",
            website: data.newInstitutionWebsite || "",
          });

          const newInstitution = await createInstitution.mutateAsync({
            name: data.newInstitutionName!.trim(),
            type: data.newInstitutionType!,
            description: data.newInstitutionDescription?.trim() || "",
            website: data.newInstitutionWebsite?.trim() || "",
          });

          if (!newInstitution?.id) {
            throw new Error("Failed to create institution - no ID returned");
          }

          institutionId = newInstitution.id;
          console.log("Institution created successfully:", institutionId);
        } catch (error) {
          console.error("Institution creation failed:", error);
          throw new Error(
            `Failed to create institution: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      // Step 2: Create account if needed (only if not already created)
      if (accountId === "new") {
        try {
          if (!institutionId) {
            throw new Error("Institution ID is required to create an account");
          }

          console.log("Creating account:", {
            name: data.newAccountName,
            type: data.newAccountType,
            institutionId: institutionId,
            description: data.newAccountDescription || "",
          });

          const newAccount = await createAccount.mutateAsync({
            name: data.newAccountName!.trim(),
            type: data.newAccountType!,
            institutionId: institutionId,
            description: data.newAccountDescription?.trim() || "",
          });

          if (!newAccount?.id) {
            throw new Error("Failed to create account - no ID returned");
          }

          accountId = newAccount.id;
          console.log("Account created successfully:", accountId);
        } catch (error) {
          console.error("Account creation failed:", error);
          throw new Error(
            `Failed to create account: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      // Step 3: Create holding
      try {
        if (
          !accountId ||
          !tokenId ||
          accountId === "new" ||
          tokenId === "new"
        ) {
          throw new Error(
            `Missing required IDs - Account: ${accountId}, Token: ${tokenId}`
          );
        }

        console.log("Creating holding:", {
          accountId,
          tokenId,
          balance: data.balance.toString(),
        });

        await createHolding.mutateAsync({
          accountId,
          tokenId,
          balance: data.balance.toString(),
        });

        console.log("Holding created successfully");

        toast({
          title: "✅ Success!",
          description:
            "Holding created successfully! Your new holding has been added to your portfolio.",
        });

        // Invalidate relevant queries to refresh data
        await Promise.all([
          utils.holdings.getAll.invalidate(),
          utils.holdings.getUnpriceableTokens.invalidate(),
          utils.accounts.getAll.invalidate(),
          utils.accounts.getSummaries.invalidate(),
          utils.institutions.getAll.invalidate(),
          utils.tokens.getAll.invalidate(),
          utils.users.getPortfolioValue.invalidate(),
        ]);

        navigate("/holdings");
      } catch (error) {
        console.error("Holding creation failed:", error);
        throw new Error(
          `Failed to create holding: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    } catch (error) {
      console.error("Overall submission failed:", error);

      const errorMessage =
        error instanceof Error ? error.message : "An unexpected error occurred";

      toast({
        title: "❌ Error Creating Holding",
        description: `${errorMessage}. Please check your information and try again.`,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLoading =
    accountsLoading ||
    institutionsLoading ||
    accountTypesLoading ||
    institutionTypesLoading;

  // Step components
  const renderAccountSelection = () => (
    <div className="space-y-6">
      <PageHeader
        title="Add Holding"
        subtitle="First, select which account you'd like to add the holding to."
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
            form.setValue("accountId", accountId);
          }}
          accounts={accounts}
          institutions={institutions}
          placeholder="Choose an account..."
        />

        {/* New Account Creation Form */}
        {selectedAccountId === "new" && (
          <div className="space-y-4 border-t pt-4">
            {/* Institution Selection - First */}
            <div className="space-y-4">
              <h3 className="text-base font-medium">Institution</h3>

              <div className="space-y-2">
                <Label htmlFor={institutionSelectId}>
                  Select Institution *
                </Label>
                <InstitutionSelector
                  id={institutionSelectId}
                  value={form.watch("institutionId") || ""}
                  onValueChange={(value) =>
                    form.setValue("institutionId", value)
                  }
                  institutions={institutions}
                  placeholder="Choose an institution..."
                />
              </div>

              {form.watch("institutionId") === "new" && (
                <div className="space-y-4 border rounded-lg p-4">
                  <h4 className="font-medium">New Institution Details</h4>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Institution Name *</Label>
                      <Input
                        placeholder="e.g., Bank of America"
                        {...form.register("newInstitutionName")}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Institution Type *</Label>
                      <InstitutionTypeSelector
                        value={form.watch("newInstitutionType") || ""}
                        onValueChange={(value) =>
                          form.setValue("newInstitutionType", value)
                        }
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
                        {...form.register("newInstitutionWebsite")}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Input
                        placeholder="Optional description"
                        {...form.register("newInstitutionDescription")}
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
                    {...form.register("newAccountName")}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Account Type *</Label>
                  <AccountTypeSelector
                    value={form.watch("newAccountType") || ""}
                    onValueChange={(value) =>
                      form.setValue("newAccountType", value)
                    }
                    accountTypes={accountTypes}
                    placeholder="Choose account type..."
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  placeholder="Optional description"
                  {...form.register("newAccountDescription")}
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
                setCurrentStep("entry-method");
              } catch (error) {
                // Error already handled in handleAccountCreation
                console.error("Failed to create account:", error);
              }
            }}
            disabled={
              !isAccountSelectionValid ||
              createAccount.isPending ||
              createInstitution.isPending
            }
          >
            {createAccount.isPending || createInstitution.isPending ? (
              <>
                <LoadingSpinner className="mr-2 h-4 w-4" />
                Creating Account...
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  const renderEntryMethodSelection = () => (
    <div className="space-y-6">
      <PageHeader
        title="Add Holding"
        subtitle={
          currentlySelectedAccount
            ? `Adding to: ${currentlySelectedAccount.name} • How would you like to add your holding?`
            : "How would you like to add your holding?"
        }
      />

      {/* Show selected account info */}
      {currentlySelectedAccount && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center space-x-2">
            <Info className="h-4 w-4 text-blue-600" />
            <div>
              <p className="text-sm font-medium text-blue-800">
                Your holding will be added to: {currentlySelectedAccount.name}
              </p>
              <p className="text-xs text-blue-600 mt-0.5">
                After completing this form, your new holdings will be added to
                this account and will appear in your portfolio.
              </p>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => handleEntryMethodSelected("manual")}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PenTool className="h-5 w-5" />
                Manual Entry
              </CardTitle>
              <CardDescription>
                Enter holding details manually using forms
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Perfect for entering holdings step by step with full control
                over all details.
              </p>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => handleEntryMethodSelected("screenshot")}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Screenshot Upload
              </CardTitle>
              <CardDescription>
                Upload a screenshot and let AI extract the details
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Take a photo of your portfolio and we'll automatically detect
                holdings.
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
    <div className="space-y-6">
      <PageHeader
        title="Add Holding"
        subtitle={
          currentlySelectedAccount
            ? `Adding to: ${currentlySelectedAccount.name} • Upload a screenshot to automatically extract holdings.`
            : "Upload a screenshot to automatically extract holdings."
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
                After uploading and reviewing your screenshot, the detected
                holdings will be added to this account.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {screenshotParsing.state === "upload" && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">
              Upload Portfolio Screenshots
            </h3>
            <p className="text-muted-foreground">
              Take screenshots or photos of your portfolio, trading apps, or any
              screens showing your holdings. You can upload multiple screenshots
              at once. Our AI will automatically detect and extract the token
              symbols and balances from all images.
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
                    title: "No account selected",
                    description: "Please go back and select an account first.",
                    variant: "destructive",
                  });
                }
              }}
              onMultipleImageUpload={(files) => {
                if (currentlySelectedAccountId) {
                  screenshotParsing.handleMultipleImageUpload(
                    files,
                    currentlySelectedAccountId
                  );
                } else {
                  toast({
                    title: "No account selected",
                    description: "Please go back and select an account first.",
                    variant: "destructive",
                  });
                }
              }}
              isProcessing={screenshotParsing.isParsing}
              maxSizeMB={10}
            />
          </div>
        )}

        {screenshotParsing.state === "parsing" && (
          <div className="text-center py-8 space-y-6">
            <LoadingSpinner className="h-8 w-8 mx-auto mb-4" />
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">
                {screenshotParsing.processingProgress
                  ? `Analyzing Screenshots...`
                  : "Analyzing Screenshot..."}
              </h3>

              {screenshotParsing.processingProgress && (
                <div className="max-w-md mx-auto space-y-3">
                  <div className="space-y-2">
                    <Progress
                      value={undefined}
                      className="w-full animate-pulse"
                    />
                    <div className="text-xs text-muted-foreground text-center">
                      Processing screenshots in parallel...
                    </div>
                  </div>
                </div>
              )}

              <p className="text-muted-foreground">
                {screenshotParsing.processingProgress
                  ? `Processing ${screenshotParsing.processingProgress.total} screenshots in parallel. Each image takes 10-30 seconds.`
                  : "Our AI is extracting holdings from your screenshot. This usually takes 10-30 seconds."}
              </p>
            </div>
          </div>
        )}

        {(screenshotParsing.state === "review" ||
          screenshotParsing.state === "processing") &&
          (screenshotParsing.parsingResults ||
            screenshotParsing.multipleResults) && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold mb-2">
                  Review Detected Holdings
                </h3>
                <p className="text-muted-foreground mb-4">
                  Please review the holdings we detected and make any necessary
                  adjustments before adding them to your account.
                </p>
              </div>

              {/* Summary */}
              <div className="bg-gray-50 rounded-lg p-4">
                {screenshotParsing.multipleResults ? (
                  <>
                    <div className="mb-4 text-sm text-muted-foreground">
                      Analysis from{" "}
                      {
                        screenshotParsing.multipleResults.overallSummary
                          .totalScreenshots
                      }{" "}
                      screenshots
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <span className="font-medium">Total Holdings:</span>
                        <div className="text-lg font-semibold">
                          {
                            screenshotParsing.multipleResults.overallSummary
                              .totalHoldings
                          }
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">Existing Tokens:</span>
                        <div className="text-lg font-semibold text-green-600">
                          {
                            screenshotParsing.multipleResults.overallSummary
                              .existingTokens
                          }
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">New Tokens:</span>
                        <div className="text-lg font-semibold text-orange-600">
                          {
                            screenshotParsing.multipleResults.overallSummary
                              .newTokensRequired
                          }
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">Avg Confidence:</span>
                        <div className="text-lg font-semibold">
                          {Math.round(
                            screenshotParsing.multipleResults.overallSummary
                              .averageConfidence * 100
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
                        {
                          screenshotParsing.parsingResults.summary
                            .existingTokens
                        }
                      </div>
                    </div>
                    <div>
                      <span className="font-medium">New Tokens:</span>
                      <div className="text-lg font-semibold text-orange-600">
                        {
                          screenshotParsing.parsingResults.summary
                            .newTokensRequired
                        }
                      </div>
                    </div>
                    <div>
                      <span className="font-medium">Avg Confidence:</span>
                      <div className="text-lg font-semibold">
                        {Math.round(
                          screenshotParsing.parsingResults.summary
                            .averageConfidence * 100
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
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Holding
                    </Button>
                  </div>
                </div>

                <div className="space-y-3">
                  {editableHoldings.map((holding, index) => {
                    const status = getHoldingStatus(holding);
                    const hasErrors =
                      holding.requiresUserSelection ||
                      holding.errors.length > 0;
                    const isEditing = isEditingHolding(index);

                    return (
                      <div
                        key={`${holding.symbol}-${holding.balance}-${index}`}
                        className={`border rounded-lg p-4 ${
                          hasErrors
                            ? "border-yellow-300 bg-yellow-50"
                            : "border-border"
                        }`}
                      >
                        {/* Error Message at Top */}
                        {hasErrors && (
                          <div className="mb-3 flex items-start gap-2 p-2 bg-yellow-100 border border-yellow-300 rounded">
                            <AlertCircle className="h-4 w-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                            <div className="text-sm text-yellow-800">
                              {holding.errors.join(", ")}
                            </div>
                          </div>
                        )}

                        {isEditing ? (
                          // Edit Mode
                          <div className="space-y-3">
                            <div className="flex items-start gap-3">
                              <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                  <Label className="text-xs text-muted-foreground">
                                    Token *
                                  </Label>
                                  <AsyncTokenSelector
                                    value={editableHoldingTokenIds[index] || ""}
                                    onValueChange={(tokenId) => {
                                      setEditableHoldingTokenIds((prev) => ({
                                        ...prev,
                                        [index]: tokenId,
                                      }));

                                      // Update holding with selected token info
                                      let updateData: Partial<ParsedHolding> =
                                        {};

                                      if (tokenId.startsWith("external:")) {
                                        // Handle external token selection
                                        try {
                                          const parts = tokenId.split(":");
                                          const metadata = JSON.parse(
                                            parts.slice(2).join(":")
                                          );
                                          console.log(
                                            "Parsed external token metadata:",
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
                                                  type:
                                                    metadata.type || "Equity", // Ensure type is always present
                                                },
                                              },
                                            },
                                            suggestedTokenType:
                                              metadata.type || "other",
                                          };
                                        } catch (error) {
                                          console.error(
                                            "Failed to parse external token metadata:",
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
                                            name: selectedToken.name || "",
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
                                        ? "Select from provider suggestions..."
                                        : "Search for a token..."
                                    }
                                    className="h-8"
                                    suggestedTokens={
                                      holding.requiresUserSelection &&
                                      holding.providerValidation?.similarMatches
                                        ? holding.providerValidation.similarMatches
                                            .filter((match) => match.metadata)
                                            .map((match) => ({
                                              symbol: match.metadata!.symbol,
                                              name: match.metadata!.name,
                                              type: match.metadata!.type.toLowerCase(),
                                              source: "external" as const,
                                              provider: match.metadata!
                                                .provider as
                                                | "finnhub"
                                                | "coingecko",
                                              metadata: match.metadata,
                                            }))
                                        : undefined
                                    }
                                    prefillSymbol={
                                      holding.requiresUserSelection
                                        ? holding.symbol
                                        : undefined
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
                                      })
                                    }
                                    placeholder="e.g. 1.234"
                                    type="number"
                                    step="any"
                                    className="h-8"
                                  />
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => deleteHolding(index)}
                                className="h-8 w-8 p-0 text-red-500 hover:text-red-700"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>

                            {holding.notes && (
                              <div>
                                <Label className="text-xs text-muted-foreground">
                                  Notes
                                </Label>
                                <Input
                                  value={holding.notes}
                                  onChange={(e) =>
                                    updateHolding(index, {
                                      notes: e.target.value,
                                    })
                                  }
                                  placeholder="Optional notes..."
                                  className="h-8"
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
                                  {holding.symbol || "Unknown Symbol"}
                                </span>
                                {holding.name && (
                                  <span className="text-muted-foreground">
                                    ({holding.name})
                                  </span>
                                )}

                                {/* Status Badge */}
                                {typeof status === "object" &&
                                status.type === "create" ? (
                                  <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                                    New Holding
                                  </span>
                                ) : typeof status === "object" &&
                                  status.type === "update" ? (
                                  <span
                                    className={`text-xs px-2 py-1 rounded ${
                                      status.isIncrease
                                        ? "bg-blue-100 text-blue-800"
                                        : "bg-yellow-100 text-yellow-800"
                                    }`}
                                  >
                                    {status.isIncrease
                                      ? "Increase"
                                      : "Decrease"}{" "}
                                    by{" "}
                                    {Math.abs(
                                      Number.parseFloat(status.difference)
                                    ).toFixed(6)}
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
                                  <span className="text-muted-foreground">
                                    Balance:
                                  </span>{" "}
                                  <span className="font-medium">
                                    {holding.balance || "0"}
                                  </span>
                                </div>

                                {typeof status === "object" &&
                                  status.type === "update" && (
                                    <div className="text-sm">
                                      <span className="text-muted-foreground">
                                        Current:
                                      </span>{" "}
                                      <span>{status.currentBalance}</span>
                                      {" → "}
                                      <span className="font-medium">
                                        {holding.balance}
                                      </span>
                                    </div>
                                  )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              <div className="text-right space-y-1">
                                <div
                                  className={`text-sm font-medium ${
                                    holding.confidence >= 0.8
                                      ? "text-green-600"
                                      : holding.confidence >= 0.6
                                      ? "text-yellow-600"
                                      : "text-red-600"
                                  }`}
                                >
                                  {Math.round(holding.confidence * 100)}%
                                  confidence
                                </div>
                              </div>

                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => toggleEditMode(index)}
                                className="h-8 w-8 p-0"
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

        {screenshotParsing.state === "error" && (
          <div className="text-center py-8">
            <div className="text-red-500 mb-4">
              <AlertCircle className="h-12 w-12 mx-auto mb-2" />
              <h3 className="text-lg font-semibold">
                Error Processing Screenshot
              </h3>
            </div>
            <p className="text-muted-foreground mb-4">
              {screenshotParsing.errorMessage}
            </p>
            <Button onClick={() => screenshotParsing.handleRetry()}>
              Try Again
            </Button>
          </div>
        )}

        <div className="flex justify-between items-center pt-6">
          <Button type="button" variant="outline" onClick={goBack}>
            Back
          </Button>
          {screenshotParsing.state === "review" &&
            (screenshotParsing.parsingResults ||
              screenshotParsing.multipleResults) &&
            (() => {
              // Calculate button text based on holding statuses
              const creates = editableHoldings.filter((h) => {
                const status = getHoldingStatus(h);
                return (
                  status === "create" ||
                  (typeof status === "object" && status.type === "create")
                );
              }).length;

              const updates = editableHoldings.filter((h) => {
                const status = getHoldingStatus(h);
                return typeof status === "object" && status.type === "update";
              }).length;

              let buttonText = "Process Holdings";
              if (creates > 0 && updates > 0) {
                buttonText = `Add ${creates} New, Update ${updates} Existing`;
              } else if (creates > 0) {
                buttonText = `Add ${creates} New Holdings`;
              } else if (updates > 0) {
                buttonText = `Update ${updates} Holdings`;
              }

              return (
                <Button
                  onClick={() => {
                    if (currentlySelectedAccountId) {
                      // Synchronize token selections with holdings before processing
                      const synchronizedHoldings = synchronizeTokenSelections();
                      screenshotParsing.handleProcessHoldings(
                        synchronizedHoldings,
                        currentlySelectedAccountId
                      );
                    }
                  }}
                  disabled={
                    screenshotParsing.isProcessing ||
                    editableHoldings.some(
                      (holding) =>
                        holding.requiresUserSelection ||
                        holding.errors.length > 0
                    )
                  }
                >
                  {screenshotParsing.isProcessing ? (
                    <>
                      <LoadingSpinner className="mr-2 h-4 w-4" />
                      Processing Holdings...
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
  );

  const renderManualEntry = () => (
    <div className="space-y-4">
      <PageHeader
        title="Add Holding"
        subtitle={
          currentlySelectedAccount
            ? `Adding to: ${currentlySelectedAccount.name} • Enter your holding details below.`
            : "Enter your holding details below."
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
                Fill out the form below to add a new holding to this account.
                All required fields are marked with *.
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
                value={form.watch("tokenId") || ""}
                onValueChange={(value: string) => {
                  if (value === "new") {
                    setIsTokenFormOpen(true);
                  } else if (value.startsWith("external:")) {
                    // Store external token data for later creation
                    form.setValue("tokenId", value);
                  } else {
                    form.setValue("tokenId", value);
                  }
                }}
                placeholder="Choose a token..."
              />
              {form.formState.errors.tokenId && (
                <p className="text-sm text-red-500">
                  {form.formState.errors.tokenId.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={balanceId}>Balance *</Label>
              <Input
                id={balanceId}
                type="number"
                step="any"
                placeholder="e.g., 100.50"
                {...form.register("balance", { valueAsNumber: true })}
                className={
                  form.formState.errors.balance ? "border-red-500" : ""
                }
              />
              {form.formState.errors.balance && (
                <p className="text-sm text-red-500">
                  {form.formState.errors.balance.message}
                </p>
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
                  value={form.watch("accountId") || ""}
                  onValueChange={(value) => form.setValue("accountId", value)}
                  accounts={accounts}
                  institutions={institutions}
                  placeholder="Choose an account..."
                />
                {form.formState.errors.accountId && (
                  <p className="text-sm text-red-500">
                    {form.formState.errors.accountId.message}
                  </p>
                )}
              </div>
            </div>

            {watchAccountId === "new" && (
              <div className="space-y-4 border-t pt-4">
                {/* Institution Selection - Now First */}
                <div className="space-y-4">
                  <h3 className="text-base font-medium">Institution</h3>

                  <div className="space-y-2">
                    <Label htmlFor={institutionSelectId}>
                      Select Institution *
                    </Label>
                    <InstitutionSelector
                      id={institutionSelectId}
                      value={form.watch("institutionId") || ""}
                      onValueChange={(value) =>
                        form.setValue("institutionId", value)
                      }
                      institutions={institutions}
                      placeholder="Choose an institution..."
                    />
                  </div>

                  {watchInstitutionId === "new" && (
                    <div className="space-y-4 border rounded-lg p-4">
                      <h4 className="font-medium">New Institution Details</h4>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Institution Name *</Label>
                          <Input
                            placeholder="e.g., Bank of America"
                            {...form.register("newInstitutionName")}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Institution Type *</Label>
                          <InstitutionTypeSelector
                            value={form.watch("newInstitutionType") || ""}
                            onValueChange={(value) =>
                              form.setValue("newInstitutionType", value)
                            }
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
                            {...form.register("newInstitutionWebsite")}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Description</Label>
                          <Input
                            placeholder="Optional description"
                            {...form.register("newInstitutionDescription")}
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
                        {...form.register("newAccountName")}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Account Type *</Label>
                      <AccountTypeSelector
                        value={form.watch("newAccountType") || ""}
                        onValueChange={(value) =>
                          form.setValue("newAccountType", value)
                        }
                        accountTypes={accountTypes}
                        placeholder="Choose account type..."
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Input
                      placeholder="Optional description"
                      {...form.register("newAccountDescription")}
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
            {isSubmitting ? "Creating..." : "Create Holding"}
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
          {currentStep === "account-selection" && renderAccountSelection()}
          {currentStep === "entry-method" && renderEntryMethodSelection()}
          {currentStep === "manual-entry" && renderManualEntry()}
          {currentStep === "screenshot-entry" && renderScreenshotEntry()}
        </>
      )}

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
          form.setValue("tokenId", token.id);
          toast({
            title: "Token selected",
            description: `${token.symbol} - ${token.name} has been selected for the holding.`,
          });
        }}
      />
    </div>
  );
}
