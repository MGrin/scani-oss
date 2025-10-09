import {
  Building2,
  Camera,
  Check,
  Coins,
  PenTool,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from "@/components/selectors/SearchableSelectors";
import { Badge } from "@/components/ui/badge";
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
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/contexts/AuthContext";
import { useEntityData } from "@/contexts/EntityDataContext";
import { useToast } from "@/hooks/use-toast";
import { trpc } from "@/lib/trpc";

type OnboardingStep =
  | "welcome"
  | "entry-method"
  | "institution-selection"
  | "account-creation"
  | "data-entry"
  | "complete";

type EntryMethod = "manual" | "screenshot" | "wallet" | null;

const STEP_ORDER: OnboardingStep[] = [
  "welcome",
  "entry-method",
  "institution-selection",
  "account-creation",
  "data-entry",
  "complete",
];

export function OnboardingWizard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const institutionSelectId = useId();

  const [currentStep, setCurrentStep] = useState<OnboardingStep>("welcome");
  const [showWizard, setShowWizard] = useState(false);
  const [selectedEntryMethod, setSelectedEntryMethod] =
    useState<EntryMethod>(null);

  // Form state for institution and account creation
  const [createNewInstitution, setCreateNewInstitution] = useState(false);
  const [selectedInstitutionId, setSelectedInstitutionId] = useState("");
  const [newInstitutionName, setNewInstitutionName] = useState("");
  const [newInstitutionType, setNewInstitutionType] = useState("");
  const [newInstitutionWebsite, setNewInstitutionWebsite] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountType, setNewAccountType] = useState("");
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);

  // Get entity data
  const {
    institutions: institutionsState,
    institutionTypes: institutionTypesState,
    accountTypes: accountTypesState,
  } = useEntityData();
  const institutions = institutionsState.data;
  const institutionTypes = institutionTypesState.data;
  const accountTypes = accountTypesState.data;

  const utils = trpc.useUtils();
  const createInstitution = trpc.institutions.create.useMutation();
  const createAccount = trpc.accounts.create.useMutation();

  // Check if user has completed onboarding - only show for authenticated users
  useEffect(() => {
    // Don't show onboarding if user is not authenticated or still loading
    if (authLoading || !user) {
      setShowWizard(false);
      return;
    }

    const hasCompleted = localStorage.getItem("scani-onboarding-completed");
    if (!hasCompleted) {
      setShowWizard(true);
    }
  }, [user, authLoading]);

  const currentStepIndex = STEP_ORDER.indexOf(currentStep);
  const progress = ((currentStepIndex + 1) / STEP_ORDER.length) * 100;

  const handleSkip = () => {
    localStorage.setItem("scani-onboarding-completed", "true");
    setShowWizard(false);
  };

  const handleComplete = () => {
    localStorage.setItem("scani-onboarding-completed", "true");
    setShowWizard(false);
    navigate("/dashboard");
  };

  const handleBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0 && STEP_ORDER[prevIndex]) {
      setCurrentStep(STEP_ORDER[prevIndex]);
    }
  };

  const handleNext = () => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < STEP_ORDER.length && STEP_ORDER[nextIndex]) {
      setCurrentStep(STEP_ORDER[nextIndex]);
    }
  };

  const handleEntryMethodSelect = (
    method: "manual" | "screenshot" | "wallet"
  ) => {
    if (method === "wallet") {
      // Not implemented yet
      return;
    }
    setSelectedEntryMethod(method);
    handleNext();
  };

  const handleCreateInstitutionAndAccount = async () => {
    try {
      let institutionId = selectedInstitutionId;

      // Create institution if needed
      if (createNewInstitution && newInstitutionName && newInstitutionType) {
        const institution = await createInstitution.mutateAsync({
          name: newInstitutionName,
          type: newInstitutionType,
          website: newInstitutionWebsite || undefined,
        });
        institutionId = institution.id;

        toast({
          title: "Institution created",
          description: `${newInstitutionName} has been added to your institutions.`,
        });
      }

      // Create account
      if (institutionId && newAccountName && newAccountType) {
        const account = await createAccount.mutateAsync({
          name: newAccountName,
          institutionId,
          type: newAccountType,
        });

        if (!account) {
          throw new Error("Failed to create account");
        }

        toast({
          title: "Account created",
          description: `${newAccountName} is ready to track your holdings.`,
        });

        // Invalidate queries to refresh data
        await utils.institutions.getAll.invalidate();
        await utils.accounts.getAll.invalidate();

        // Save the created account ID
        setCreatedAccountId(account.id);

        // Move to data-entry step
        setCurrentStep("data-entry");
      }
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to create account",
        variant: "destructive",
      });
    }
  };

  const canProceedToAccountCreation = createNewInstitution
    ? newInstitutionName && newInstitutionType
    : selectedInstitutionId;

  const canCreateAccount =
    newAccountName && newAccountType && canProceedToAccountCreation;

  if (!showWizard) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <div className="flex justify-between items-center mb-4">
            <CardTitle>Getting Started with Scani</CardTitle>
            <Button variant="ghost" size="sm" onClick={handleSkip}>
              <X className="h-4 w-4 mr-1" />
              Skip
            </Button>
          </div>
          <Progress value={progress} className="h-2" />
          <CardDescription className="mt-2">
            Step {currentStepIndex + 1} of {STEP_ORDER.length}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Welcome Step */}
          {currentStep === "welcome" && (
            <div className="flex flex-col items-center text-center space-y-4 py-8">
              <Coins className="h-16 w-16 text-primary mb-4" />
              <h2 className="text-3xl font-bold">Welcome to Scani!</h2>
              <p className="text-muted-foreground max-w-md text-lg">
                Your personal finance companion for tracking investments across
                all your accounts.
              </p>
              <p className="text-muted-foreground max-w-md">
                Let's get you set up in just a few steps. We'll create your
                first account and help you add your holdings.
              </p>

              <div className="flex justify-center pt-4">
                <Button onClick={handleNext} size="lg" className="gap-2">
                  Get Started
                  <Check className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Entry Method Selection */}
          {currentStep === "entry-method" && (
            <div className="space-y-6 py-4">
              <div className="text-center space-y-2">
                <h2 className="text-2xl font-bold">
                  How would you like to add your data?
                </h2>
                <p className="text-muted-foreground">
                  Choose the method that works best for you
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <Card
                  className="cursor-pointer hover:shadow-md transition-shadow hover:border-primary"
                  onClick={() => handleEntryMethodSelect("manual")}
                >
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <PenTool className="h-5 w-5" />
                      Manual Entry
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Enter holdings manually with full control over details
                    </p>
                  </CardContent>
                </Card>

                <Card
                  className="cursor-pointer hover:shadow-md transition-shadow hover:border-primary"
                  onClick={() => handleEntryMethodSelect("screenshot")}
                >
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Camera className="h-5 w-5" />
                      Screenshot Upload
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Upload a screenshot and let AI extract holdings
                    </p>
                  </CardContent>
                </Card>

                <Card className="relative opacity-60 cursor-not-allowed">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Wallet className="h-5 w-5" />
                      Crypto Wallet
                      <Badge variant="secondary" className="ml-auto text-xs">
                        Soon
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      Connect wallet to auto-sync holdings
                    </p>
                  </CardContent>
                </Card>
              </div>

              <div className="flex justify-between pt-4 border-t">
                <Button variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <div />
              </div>
            </div>
          )}

          {/* Institution Selection */}
          {currentStep === "institution-selection" && (
            <div className="space-y-6 py-4">
              <div className="text-center space-y-2">
                <Building2 className="h-12 w-12 text-primary mx-auto mb-2" />
                <h2 className="text-2xl font-bold">
                  Select or Create Institution
                </h2>
                <p className="text-muted-foreground">
                  Choose where you hold your assets (bank, brokerage, exchange,
                  etc.)
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={institutionSelectId}>Institution</Label>
                  <InstitutionSelector
                    id={institutionSelectId}
                    value={createNewInstitution ? "new" : selectedInstitutionId}
                    onValueChange={(val) => {
                      if (val === "new") {
                        setCreateNewInstitution(true);
                        setSelectedInstitutionId("");
                      } else {
                        setCreateNewInstitution(false);
                        setSelectedInstitutionId(val);
                      }
                    }}
                    institutions={institutions || []}
                  />
                </div>

                {createNewInstitution && (
                  <div className="space-y-4 border rounded-lg p-4 bg-muted/20">
                    <div className="flex justify-between items-center">
                      <h3 className="text-sm font-medium">
                        New Institution Details
                      </h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCreateNewInstitution(false);
                          setNewInstitutionName("");
                          setNewInstitutionType("");
                          setNewInstitutionWebsite("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>

                    <div className="space-y-2">
                      <Label>Institution Name *</Label>
                      <Input
                        placeholder="e.g., Chase Bank"
                        value={newInstitutionName}
                        onChange={(e) => setNewInstitutionName(e.target.value)}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Institution Type *</Label>
                      <InstitutionTypeSelector
                        value={newInstitutionType}
                        onValueChange={setNewInstitutionType}
                        institutionTypes={institutionTypes || []}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Website (Optional)</Label>
                      <Input
                        placeholder="https://example.com"
                        value={newInstitutionWebsite}
                        onChange={(e) =>
                          setNewInstitutionWebsite(e.target.value)
                        }
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-between pt-4 border-t">
                <Button variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <Button
                  onClick={handleNext}
                  disabled={!canProceedToAccountCreation}
                >
                  Continue
                </Button>
              </div>
            </div>
          )}

          {/* Account Creation */}
          {currentStep === "account-creation" && (
            <div className="space-y-6 py-4">
              <div className="text-center space-y-2">
                <Wallet className="h-12 w-12 text-primary mx-auto mb-2" />
                <h2 className="text-2xl font-bold">Create Your Account</h2>
                <p className="text-muted-foreground">
                  Set up an account to track holdings within{" "}
                  {createNewInstitution
                    ? newInstitutionName
                    : institutions?.find((i) => i.id === selectedInstitutionId)
                        ?.name}
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Account Name *</Label>
                  <Input
                    placeholder="e.g., Main Trading Account"
                    value={newAccountName}
                    onChange={(e) => setNewAccountName(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Account Type *</Label>
                  <AccountTypeSelector
                    value={newAccountType}
                    onValueChange={setNewAccountType}
                    accountTypes={accountTypes || []}
                  />
                </div>
              </div>

              <div className="flex justify-between pt-4 border-t">
                <Button variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <Button
                  onClick={handleCreateInstitutionAndAccount}
                  disabled={
                    !canCreateAccount ||
                    createInstitution.isPending ||
                    createAccount.isPending
                  }
                >
                  {createInstitution.isPending || createAccount.isPending
                    ? "Creating..."
                    : "Create Account"}
                </Button>
              </div>
            </div>
          )}

          {/* Data Entry Step */}
          {currentStep === "data-entry" && (
            <div className="space-y-6 py-4">
              {selectedEntryMethod === "manual" ? (
                <>
                  <div className="text-center space-y-2">
                    <Coins className="h-12 w-12 text-primary mx-auto mb-2" />
                    <h2 className="text-2xl font-bold">
                      Add Your First Holding
                    </h2>
                    <p className="text-muted-foreground">
                      Enter details about the assets you hold in{" "}
                      {newAccountName}
                    </p>
                  </div>

                  <div className="flex flex-col items-center gap-4 py-6">
                    <p className="text-sm text-muted-foreground text-center max-w-md">
                      You'll be redirected to the data entry page where you can
                      add holdings to your account.
                    </p>

                    <div className="flex flex-col gap-2 w-full max-w-xs">
                      <Button
                        onClick={() => {
                          // Complete onboarding and navigate to add-data with account prefilled
                          localStorage.setItem(
                            "scani-onboarding-completed",
                            "true"
                          );
                          setShowWizard(false);
                          navigate(
                            `/add-data?accountId=${createdAccountId}&method=manual`
                          );
                        }}
                        className="gap-2"
                      >
                        <PenTool className="h-4 w-4" />
                        Go to Manual Entry
                      </Button>

                      <Button
                        variant="outline"
                        onClick={() => setCurrentStep("complete")}
                      >
                        Skip for Now
                      </Button>
                    </div>
                  </div>

                  <div className="flex justify-between pt-4 border-t">
                    <Button variant="outline" onClick={handleBack}>
                      Back
                    </Button>
                    <div />
                  </div>
                </>
              ) : selectedEntryMethod === "screenshot" ? (
                <>
                  <div className="text-center space-y-2">
                    <Camera className="h-12 w-12 text-primary mx-auto mb-2" />
                    <h2 className="text-2xl font-bold">Upload a Screenshot</h2>
                    <p className="text-muted-foreground">
                      Let's add your holdings from a screenshot of{" "}
                      {newAccountName}
                    </p>
                  </div>

                  <div className="flex flex-col items-center gap-4 py-6">
                    <p className="text-sm text-muted-foreground text-center max-w-md">
                      You'll be redirected to the screenshot upload page where
                      you can upload images and our AI will extract your
                      holdings automatically.
                    </p>

                    <div className="flex flex-col gap-2 w-full max-w-xs">
                      <Button
                        onClick={() => {
                          // Complete onboarding and navigate to add-data with account prefilled
                          localStorage.setItem(
                            "scani-onboarding-completed",
                            "true"
                          );
                          setShowWizard(false);
                          navigate(
                            `/add-data?accountId=${createdAccountId}&method=screenshot`
                          );
                        }}
                        className="gap-2"
                      >
                        <Camera className="h-4 w-4" />
                        Go to Screenshot Upload
                      </Button>

                      <Button
                        variant="outline"
                        onClick={() => setCurrentStep("complete")}
                      >
                        Skip for Now
                      </Button>
                    </div>
                  </div>

                  <div className="flex justify-between pt-4 border-t">
                    <Button variant="outline" onClick={handleBack}>
                      Back
                    </Button>
                    <div />
                  </div>
                </>
              ) : null}
            </div>
          )}

          {/* Complete Step */}
          {currentStep === "complete" && (
            <div className="flex flex-col items-center text-center space-y-4 py-8">
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Check className="h-8 w-8 text-primary" />
              </div>
              <h2 className="text-3xl font-bold">Welcome to Scani!</h2>
              <p className="text-muted-foreground max-w-md">
                Your account <strong>{newAccountName}</strong> is ready. You can
                add holdings anytime from your dashboard or the accounts page.
              </p>

              <div className="flex gap-3 pt-4">
                <Button onClick={handleComplete} className="gap-2">
                  Go to Dashboard
                  <Check className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
