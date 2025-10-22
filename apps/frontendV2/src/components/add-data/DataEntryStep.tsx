import { useEffect, useMemo } from "react";
import { ManualEntryStep } from "@/components/add-data/ManualEntryStep";
import { ScreenshotUploadStep } from "@/components/add-data/ScreenshotUploadStep";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import type { CompleteImportData } from "@/types/addData";

interface DataEntryStepProps {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  isCreatingHoldings: boolean;
  onChangesDetected?: (hasChanges: boolean) => void;
}

export function DataEntryStep({
  completeImportData,
  onCompleteDataUpdate,
  isCreatingHoldings,
  onChangesDetected,
}: DataEntryStepProps) {
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
      // Initialize with existing holdings + one empty new holding
      return [
        ...existingHoldings.map((holding) => ({
          id: holding.id,
          tokenValue: holding.token.id,
          amount: holding.amount.toString(),
          isExisting: true,
          originalAmount: holding.amount.toString(),
        })),
        {
          id: `new-${Date.now()}`,
          tokenValue: "",
          amount: "",
          isExisting: false,
        },
      ];
    }

    // For new accounts or when holdings are already initialized
    if (currentHoldings.length === 0) {
      return [
        {
          id: `new-${Date.now()}`,
          tokenValue: "",
          amount: "",
          isExisting: false,
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
      (h) =>
        "originalAmount" in h &&
        h.amount !== h.originalAmount &&
        h.amount.trim() !== ""
    );

    return hasNewHoldings || hasExistingChanges;
  }, [holdings]);

  // Notify parent of changes
  useEffect(() => {
    onChangesDetected?.(hasChanges);
  }, [hasChanges, onChangesDetected]);

  const renderDataEntryForm = () => {
    switch (completeImportData.method) {
      case "manual":
        return (
          <ManualEntryStep
            completeImportData={completeImportData}
            onCompleteDataUpdate={onCompleteDataUpdate}
            isCreatingHoldings={isCreatingHoldings}
          />
        );

      case "screenshots":
        return (
          <ScreenshotUploadStep
            completeImportData={completeImportData}
            onCompleteDataUpdate={onCompleteDataUpdate}
            isCreatingHoldings={isCreatingHoldings}
            onChangesDetected={onChangesDetected}
          />
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
