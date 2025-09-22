import { useEffect, useId } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  AccountSelector,
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from "@/components/selectors/SearchableSelectors";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

// Form data interface that matches the structure expected by this component
export interface AccountSelectionFormData {
  // Account selection
  accountId: string;

  // New account fields (conditionally required when accountId is 'new')
  newAccountName?: string;
  newAccountType?: string;
  newAccountDescription?: string;

  // Institution selection (conditionally required when creating new account)
  institutionId?: string;

  // New institution fields (conditionally required when institutionId is 'new')
  newInstitutionName?: string;
  newInstitutionType?: string;
  newInstitutionDescription?: string;
  newInstitutionWebsite?: string;
}

interface AccountSelectionWithCreationProps {
  // React Hook Form instance - accepts any form that contains AccountSelectionFormData fields
  // biome-ignore lint/suspicious/noExplicitAny: Component needs to work with various form types that extend AccountSelectionFormData
  form: UseFormReturn<any>;

  // Optional props for customization
  showDescription?: boolean;
  accountLabelOverride?: string;
  institutionLabelOverride?: string;

  // Callback when account is selected (useful for parent components)
  onAccountSelected?: (accountId: string) => void;
}

export function AccountSelectionWithCreation({
  form,
  showDescription = true,
  accountLabelOverride,
  institutionLabelOverride,
  onAccountSelected,
}: AccountSelectionWithCreationProps) {
  // Form IDs for accessibility - EXACTLY FROM QuickAddHolding.tsx
  const accountSelectId = useId();
  const institutionSelectId = useId();

  // Data queries - EXACTLY FROM QuickAddHolding.tsx
  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.getAll.useQuery();
  const { data: institutions, isLoading: institutionsLoading } =
    trpc.institutions.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  // Watch values for conditional rendering - EXACTLY FROM QuickAddHolding.tsx
  const watchAccountId = form.watch("accountId");
  const watchInstitutionId = form.watch("institutionId");

  // EXACT LOGIC FROM QuickAddHolding.tsx - Set default values based on available data
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

  // Handle account selection callback
  useEffect(() => {
    if (watchAccountId && watchAccountId !== "new" && onAccountSelected) {
      onAccountSelected(watchAccountId);
    }
  }, [watchAccountId, onAccountSelected]);

  // EXACT UI FROM QuickAddHolding.tsx - Account Selection section
  return (
    <div className="bg-card border rounded-lg p-4 space-y-4">
      <h2 className="text-lg font-semibold">Account</h2>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={accountSelectId}>
            {accountLabelOverride || "Select Account"} *
          </Label>
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
              {String(form.formState.errors.accountId.message)}
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
                {institutionLabelOverride || "Select Institution"} *
              </Label>
              <InstitutionSelector
                id={institutionSelectId}
                value={form.watch("institutionId") || ""}
                onValueChange={(value) => form.setValue("institutionId", value)}
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

            {showDescription && (
              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  placeholder="Optional description"
                  {...form.register("newAccountDescription")}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Helper function to create the mutations that this component needs
export function useAccountCreationMutations() {
  const utils = trpc.useUtils();

  const createInstitution = trpc.institutions.create.useMutation({
    onSuccess: () => {
      utils.institutions.getAll.invalidate();
    },
  });

  const createAccount = trpc.accounts.create.useMutation({
    onSuccess: () => {
      utils.accounts.getAll.invalidate();
      utils.accounts.getSummaries.invalidate();
    },
  });

  return {
    createInstitution,
    createAccount,
  };
}

// Helper function to process account/institution creation based on form data
export async function processAccountCreation(
  data: AccountSelectionFormData,
  mutations: ReturnType<typeof useAccountCreationMutations>
): Promise<string> {
  let accountId = data.accountId;
  let institutionId = data.institutionId;

  // Step 1: Create institution if needed
  if (data.accountId === "new" && data.institutionId === "new") {
    if (!data.newInstitutionName || !data.newInstitutionType) {
      throw new Error(
        "Institution name and type are required when creating a new institution"
      );
    }

    const newInstitution = await mutations.createInstitution.mutateAsync({
      name: data.newInstitutionName.trim(),
      type: data.newInstitutionType,
      description: data.newInstitutionDescription?.trim() || "",
      website: data.newInstitutionWebsite?.trim() || "",
    });

    if (!newInstitution?.id) {
      throw new Error("Failed to create institution - no ID returned");
    }

    institutionId = newInstitution.id;
  }

  // Step 2: Create account if needed
  if (data.accountId === "new") {
    if (!institutionId) {
      throw new Error("Institution ID is required to create an account");
    }

    if (!data.newAccountName || !data.newAccountType) {
      throw new Error(
        "Account name and type are required when creating a new account"
      );
    }

    const newAccount = await mutations.createAccount.mutateAsync({
      name: data.newAccountName.trim(),
      type: data.newAccountType,
      institutionId: institutionId,
      description: data.newAccountDescription?.trim() || "",
    });

    if (!newAccount?.id) {
      throw new Error("Failed to create account - no ID returned");
    }

    accountId = newAccount.id;
  }

  if (accountId === "new") {
    throw new Error("Failed to resolve account ID after creation process");
  }

  return accountId;
}
