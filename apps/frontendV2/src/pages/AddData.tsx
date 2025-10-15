import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import {
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from "@/components/selectors/SearchableSelectors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";

type Step = "method" | "account" | "data";

interface FormData {
  method?: "manual" | "screenshots" | "wallet";
  accountId?: string;
  // Add more fields as needed
}

export function AddData() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentStep, setCurrentStep] = useState<Step>("method");
  const [formData, setFormData] = useState<FormData>({});
  const [navContainer, setNavContainer] = useState<Element | null>(null);
  const [isAccountStepValid, setIsAccountStepValid] = useState(false);
  const [accountDisplayText, setAccountDisplayText] =
    useState<string>("Choose Account");

  useEffect(() => {
    const container = document.getElementById("mobile-bottom-nav");
    setNavContainer(container);
  }, []);

  // Load form data from URL params on mount
  useEffect(() => {
    const method = searchParams.get("method") as FormData["method"];
    const accountId = searchParams.get("accountId");

    if (method) {
      setFormData((prev) => ({ ...prev, method }));
      setCurrentStep("account");
    }

    if (accountId) {
      setFormData((prev) => ({ ...prev, accountId }));
      setCurrentStep("data");
    }
  }, [searchParams]);

  // Update URL params when form data changes
  const updateFormData = (updates: Partial<FormData>) => {
    const newData = { ...formData, ...updates };
    setFormData(newData);

    const params = new URLSearchParams();
    if (newData.method) params.set("method", newData.method);
    if (newData.accountId) params.set("accountId", newData.accountId);

    setSearchParams(params);
  };

  // Fetch data needed for progress bar display
  // Note: Account and institution data is handled by AccountSelectionStep

  const nextStep = () => {
    if (currentStep === "method") setCurrentStep("account");
    else if (currentStep === "account") setCurrentStep("data");
  };

  const prevStep = () => {
    if (currentStep === "data") {
      // Going back from data entry to account selection
      // Clear accountId from form data and URL
      const newData = { ...formData };
      delete newData.accountId;
      setFormData(newData);

      const params = new URLSearchParams();
      if (newData.method) params.set("method", newData.method);
      // Don't set accountId since we're clearing it
      setSearchParams(params);

      setCurrentStep("account");
    } else if (currentStep === "account") {
      // Going back from account selection to method selection
      // Clear method and accountId from form data and URL
      setFormData({});
      setSearchParams(new URLSearchParams());
      setCurrentStep("method");
    }
  };

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

  // Helper functions for progress bar display text
  const getMethodDisplayText = (): string => {
    if (!formData.method) return "Select Method";

    const methods = [
      { id: "manual", title: "Manual Entry" },
      { id: "screenshots", title: "Screenshots Upload" },
      { id: "wallet", title: "Cryptocurrency Wallet" },
    ];

    const selectedMethod = methods.find((m) => m.id === formData.method);
    return selectedMethod ? selectedMethod.title : "Select Method";
  };

  const getAccountDisplayText = (): string => {
    return accountDisplayText;
  };

  return (
    <div className="space-y-6 pb-24">
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
        <MethodSelectionStep formData={formData} onUpdate={updateFormData} />
      )}
      {currentStep === "account" && (
        <AccountSelectionStep
          onUpdate={updateFormData}
          onValidationChange={setIsAccountStepValid}
          onAccountDisplayChange={(displayText) =>
            setAccountDisplayText(displayText)
          }
        />
      )}
      {currentStep === "data" && <DataEntryStep formData={formData} />}

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
                onClick={() => {
                  if (currentStep === "method" && formData.method) {
                    nextStep();
                  } else if (currentStep === "account") {
                    // For account step, we can always proceed since account selection is optional
                    nextStep();
                  } else if (currentStep === "data") {
                    // Handle completion
                    console.log("Completing import...");
                  }
                }}
                disabled={
                  (currentStep === "method" && !formData.method) ||
                  (currentStep === "account" && !isAccountStepValid) ||
                  (currentStep === "data" && false) // Always allow completion on data step
                }
              >
                {currentStep === "data" ? "Complete Import" : "Continue"}
              </Button>
            </div>
          </div>,
          navContainer
        )}
    </div>
  );
}

function MethodSelectionStep({
  formData,
  onUpdate,
}: {
  formData: FormData;
  onUpdate: (updates: Partial<FormData>) => void;
}) {
  const methods = [
    {
      id: "manual" as const,
      title: "Manual Entry",
      description:
        "Manually enter your holdings, transactions, and account information",
      icon: "📝",
    },
    {
      id: "screenshots" as const,
      title: "Screenshots Upload",
      description:
        "Upload screenshots of your statements and let AI extract the data",
      icon: "📸",
    },
    {
      id: "wallet" as const,
      title: "Cryptocurrency Wallet",
      description:
        "Connect your crypto wallet to automatically import holdings",
      icon: "🔐",
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
              className={`cursor-pointer transition-all hover:shadow-md ${
                formData.method === method.id ? "ring-2 ring-primary" : ""
              }`}
              onClick={() => onUpdate({ method: method.id })}
            >
              <CardContent className="p-4 md:p-6 text-center">
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
  onUpdate,
  onValidationChange,
  onAccountDisplayChange,
}: {
  onUpdate: (updates: Partial<FormData>) => void;
  onValidationChange?: (isValid: boolean) => void;
  onAccountDisplayChange?: (displayText: string) => void;
}) {
  const [mode, setMode] = useState<"select" | "create">("select");
  const accountNameId = useId();
  const institutionNameId = useId();
  const institutionWebsiteId = useId();
  const institutionDescriptionId = useId();
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [institutionMode, setInstitutionMode] = useState<"select" | "create">(
    "select"
  );
  const [newAccountData, setNewAccountData] = useState({
    name: "",
    institutionId: "",
    typeId: "",
    newInstitutionName: "",
    newInstitutionTypeId: "",
    newInstitutionWebsite: "",
    newInstitutionDescription: "",
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

  // Mutations for creating new items
  const utils = trpc.useUtils();
  const createInstitution = trpc.institutions.create.useMutation({
    onSuccess: () => {
      // Refetch institutions
      utils.institutions.getAll.invalidate();
    },
  });

  // Query for fetching Open Graph metadata (disabled by default, triggered manually)
  const metadataQuery = trpc.institutions.getOpenGraphMetadata.useQuery(
    { url: newAccountData.newInstitutionWebsite },
    {
      enabled: false, // Don't fetch automatically
      onSuccess: (data) => {
        setInstitutionMetadata(data);
        setHasFetchedMetadata(true);
        // Auto-populate fields with metadata if available
        if (data.title && !newAccountData.newInstitutionName) {
          setNewAccountData((prev) => ({
            ...prev,
            newInstitutionName: data.title,
          }));
        }
        if (data.description && !newAccountData.newInstitutionDescription) {
          setNewAccountData((prev) => ({
            ...prev,
            newInstitutionDescription: data.description,
          }));
        }
      },
    }
  );

  // Callback functions for creating new items
  const handleCreateInstitution = async (name: string) => {
    try {
      // For new institutions, we need an institution type. Use the first available one or prompt user
      const defaultTypeId = institutionTypes?.[0]?.id;
      if (!defaultTypeId) {
        alert("Please create an institution type first");
        return;
      }
      const result = await createInstitution.mutateAsync({
        name,
        type: defaultTypeId,
      });
      // Set the newly created institution as selected
      setNewAccountData((prev) => ({ ...prev, institutionId: result.id }));
    } catch (error) {
      console.error("Failed to create institution:", error);
    }
  };

  // Handler for fetching metadata from website
  const handleFetchMetadata = async () => {
    if (!newAccountData.newInstitutionWebsite.trim()) {
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

  // Validation function
  const isValidForContinue = useCallback(() => {
    if (mode === "select") {
      return selectedAccountId.trim() !== "";
    } else if (mode === "create") {
      // Check account details
      const hasAccountDetails =
        newAccountData.name.trim() !== "" &&
        newAccountData.typeId.trim() !== "";

      if (!hasAccountDetails) return false;

      // Check institution details
      if (institutionMode === "select") {
        return newAccountData.institutionId.trim() !== "";
      } else if (institutionMode === "create") {
        return (
          newAccountData.newInstitutionName.trim() !== "" &&
          newAccountData.newInstitutionTypeId.trim() !== ""
        );
      }

      return false;
    }
    return false;
  }, [
    institutionMode,
    mode,
    newAccountData.institutionId,
    newAccountData.name,
    newAccountData.newInstitutionName,
    newAccountData.newInstitutionTypeId,
    newAccountData.typeId,
    selectedAccountId,
  ]);

  // Notify parent of validation changes
  useEffect(() => {
    onValidationChange?.(isValidForContinue());
  }, [onValidationChange, isValidForContinue]);

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

      if (institutionMode === "select" && newAccountData.institutionId) {
        // Existing institution selected for new account
        const institution = institutions?.find(
          (inst) => inst.id === newAccountData.institutionId
        );
        institutionName = institution?.name || "Unknown Institution";
      } else if (
        institutionMode === "create" &&
        newAccountData.newInstitutionName.trim()
      ) {
        // New institution being created
        institutionName = newAccountData.newInstitutionName;
      }

      displayText = `${newAccountData.name} (${institutionName})`;
    }

    onAccountDisplayChange?.(displayText);
  }, [
    mode,
    selectedAccountId,
    newAccountData.name,
    newAccountData.institutionId,
    newAccountData.newInstitutionName,
    institutionMode,
    accounts,
    institutions,
    onAccountDisplayChange,
  ]);

  const handleAccountSelect = (accountId: string) => {
    setSelectedAccountId(accountId);
    onUpdate({ accountId });
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
                    institutionMode === "select" ? "ring-2 ring-primary" : ""
                  }`}
                  onClick={() => {
                    setInstitutionMode("select");
                    setNewAccountData((prev) => ({
                      ...prev,
                      institutionId: "",
                      newInstitutionName: "",
                      newInstitutionTypeId: "",
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
                    institutionMode === "create" ? "ring-2 ring-primary" : ""
                  }`}
                  onClick={() => {
                    setInstitutionMode("create");
                    setNewAccountData((prev) => ({
                      ...prev,
                      institutionId: "",
                      newInstitutionName: "",
                      newInstitutionTypeId: "",
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
              {institutionMode === "select" && (
                <div className="space-y-3">
                  <Label className="text-base font-medium">
                    Choose Institution
                  </Label>
                  <InstitutionSelector
                    value={newAccountData.institutionId}
                    onValueChange={(value) =>
                      setNewAccountData((prev) => ({
                        ...prev,
                        institutionId: value,
                      }))
                    }
                    institutions={institutions}
                    placeholder="Select an institution"
                    onCreateNew={handleCreateInstitution}
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
              {institutionMode === "create" && (
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
                        value={newAccountData.newInstitutionWebsite}
                        onChange={(e) =>
                          setNewAccountData((prev) => ({
                            ...prev,
                            newInstitutionWebsite: e.target.value,
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
                          !newAccountData.newInstitutionWebsite.trim() ||
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
                            value={newAccountData.newInstitutionName}
                            onChange={(e) =>
                              setNewAccountData((prev) => ({
                                ...prev,
                                newInstitutionName: e.target.value,
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
                            value={newAccountData.newInstitutionTypeId}
                            onValueChange={(value) =>
                              setNewAccountData((prev) => ({
                                ...prev,
                                newInstitutionTypeId: value,
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
                          value={newAccountData.newInstitutionDescription}
                          onChange={(e) =>
                            setNewAccountData((prev) => ({
                              ...prev,
                              newInstitutionDescription: e.target.value,
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

function DataEntryStep({ formData }: { formData: FormData }) {
  const renderDataEntryForm = () => {
    switch (formData.method) {
      case "manual":
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h3 className="text-lg font-semibold mb-2">Manual Data Entry</h3>
              <p className="text-muted-foreground">
                Enter your financial data manually. You can add transactions,
                holdings, or other financial records.
              </p>
            </div>

            {/* TODO: Implement manual data entry form */}
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <p>Manual data entry form coming soon...</p>
                <p className="text-sm mt-2">
                  This will include forms for transactions, holdings, etc.
                </p>
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
