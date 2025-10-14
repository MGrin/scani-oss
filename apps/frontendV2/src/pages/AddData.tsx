import { useEffect, useId, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";

type Step = "method" | "account" | "data";

interface FormData {
  method?: "manual" | "screenshots" | "wallet";
  accountId?: string;
  // Add more fields as needed
}

export function AddData() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<Step>("method");
  const [formData, setFormData] = useState<FormData>({});

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

  const nextStep = () => {
    if (currentStep === "method") setCurrentStep("account");
    else if (currentStep === "account") setCurrentStep("data");
  };

  const prevStep = () => {
    if (currentStep === "data") setCurrentStep("account");
    else if (currentStep === "account") setCurrentStep("method");
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add Data"
        subtitle="Import your financial data into Scani"
        backButton={{
          onClick: () => navigate("/"),
          label: "Back to Dashboard",
        }}
      />

      {/* Progress Indicator */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                Step {getStepNumber(currentStep)} of 3
              </h2>
              <Badge variant="outline">
                {Math.round(getProgress())}% Complete
              </Badge>
            </div>
            <Progress value={getProgress()} className="w-full" />

            <div className="flex justify-between text-sm text-muted-foreground">
              <span
                className={
                  currentStep === "method" ? "font-medium text-foreground" : ""
                }
              >
                1. Select Method
              </span>
              <span
                className={
                  currentStep === "account" ? "font-medium text-foreground" : ""
                }
              >
                2. Choose Account
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
          formData={formData}
          onUpdate={updateFormData}
          onNext={nextStep}
        />
      )}
      {currentStep === "account" && (
        <AccountSelectionStep
          formData={formData}
          onUpdate={updateFormData}
          onNext={nextStep}
          onPrev={prevStep}
        />
      )}
      {currentStep === "data" && (
        <DataEntryStep formData={formData} onPrev={prevStep} />
      )}
    </div>
  );
}

function MethodSelectionStep({
  formData,
  onUpdate,
  onNext,
}: {
  formData: FormData;
  onUpdate: (updates: Partial<FormData>) => void;
  onNext: () => void;
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
              <CardContent className="p-6 text-center">
                <div className="text-4xl mb-4">{method.icon}</div>
                <h3 className="font-semibold mb-2">{method.title}</h3>
                <p className="text-sm text-muted-foreground">
                  {method.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex justify-end pt-4">
          <Button onClick={onNext} disabled={!formData.method}>
            Continue
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountSelectionStep({
  onUpdate,
  onNext,
  onPrev,
}: {
  formData: FormData;
  onUpdate: (updates: Partial<FormData>) => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const [mode, setMode] = useState<"select" | "create">("select");
  const accountNameId = useId();
  const institutionNameId = useId();
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [newAccountData, setNewAccountData] = useState({
    name: "",
    institutionId: "",
    typeId: "",
    newInstitutionName: "",
    newInstitutionTypeId: "",
  });

  // Fetch data
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  const handleAccountSelect = (accountId: string) => {
    setSelectedAccountId(accountId);
    onUpdate({ accountId });
  };

  const handleCreateAccount = () => {
    // TODO: Implement account creation
    console.log("Creating account:", newAccountData);
    // For now, just proceed
    onNext();
  };

  const canProceed =
    mode === "select"
      ? !!selectedAccountId
      : newAccountData.name &&
        newAccountData.institutionId &&
        newAccountData.typeId;

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
              <CardContent className="p-6 text-center">
                <div className="text-3xl mb-4">📋</div>
                <h3 className="font-semibold mb-2">Select Existing Account</h3>
                <p className="text-sm text-muted-foreground">
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
              <CardContent className="p-6 text-center">
                <div className="text-3xl mb-4">➕</div>
                <h3 className="font-semibold mb-2">Create New Account</h3>
                <p className="text-sm text-muted-foreground">
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
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {accounts?.map((account) => {
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
            {(!accounts || accounts.length === 0) && (
              <div className="text-center py-8 text-muted-foreground">
                <p>No accounts found. Try creating a new account instead.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Account Creation */}
      {mode === "create" && (
        <Card>
          <CardHeader>
            <CardTitle>Create New Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Account Details */}
            <div className="space-y-4">
              <div>
                <Label htmlFor="account-name">Account Name</Label>
                <Input
                  id={accountNameId}
                  placeholder="e.g., Checking Account, Investment Portfolio"
                  value={newAccountData.name}
                  onChange={(e) =>
                    setNewAccountData((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                />
              </div>

              <div>
                <Label htmlFor="account-type">Account Type</Label>
                <Select
                  value={newAccountData.typeId}
                  onValueChange={(value) =>
                    setNewAccountData((prev) => ({ ...prev, typeId: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select account type" />
                  </SelectTrigger>
                  <SelectContent>
                    {accountTypes?.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Separator />

            {/* Institution Selection/Creation */}
            <div className="space-y-4">
              <h4 className="font-medium">Institution</h4>

              <div>
                <Label htmlFor="institution">Select Existing Institution</Label>
                <Select
                  value={newAccountData.institutionId}
                  onValueChange={(value) =>
                    setNewAccountData((prev) => ({
                      ...prev,
                      institutionId: value,
                      newInstitutionName: "",
                      newInstitutionTypeId: "",
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose institution" />
                  </SelectTrigger>
                  <SelectContent>
                    {institutions?.map((inst) => (
                      <SelectItem key={inst.id} value={inst.id}>
                        {inst.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="text-center text-sm text-muted-foreground">
                <span>or</span>
              </div>

              <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
                <h5 className="font-medium">Create New Institution</h5>

                <div>
                  <Label htmlFor="new-institution-name">Institution Name</Label>
                  <Input
                    id={institutionNameId}
                    placeholder="e.g., Bank of America, Vanguard"
                    value={newAccountData.newInstitutionName}
                    onChange={(e) =>
                      setNewAccountData((prev) => ({
                        ...prev,
                        newInstitutionName: e.target.value,
                        institutionId: "",
                      }))
                    }
                  />
                </div>

                <div>
                  <Label htmlFor="new-institution-type">Institution Type</Label>
                  <Select
                    value={newAccountData.newInstitutionTypeId}
                    onValueChange={(value) =>
                      setNewAccountData((prev) => ({
                        ...prev,
                        newInstitutionTypeId: value,
                        institutionId: "",
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {institutionTypes?.map((type) => (
                        <SelectItem key={type.id} value={type.id}>
                          {type.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={onPrev}>
          Back
        </Button>
        <Button
          onClick={mode === "create" ? handleCreateAccount : onNext}
          disabled={!canProceed}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function DataEntryStep({
  formData,
  onPrev,
}: {
  formData: FormData;
  onPrev: () => void;
}) {
  const navigate = useNavigate();

  const handleComplete = () => {
    // TODO: Implement data submission based on method
    console.log("Submitting data:", formData);
    // For now, just navigate back to dashboard
    navigate("/");
  };

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

  return (
    <div className="space-y-6">
      {renderDataEntryForm()}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onPrev}>
          Back
        </Button>
        <Button onClick={handleComplete}>Complete Import</Button>
      </div>
    </div>
  );
}
