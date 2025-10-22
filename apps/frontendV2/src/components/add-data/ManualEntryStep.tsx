import { HoldingInputRow } from "@/components/add-data/HoldingInputRow";
import { useHoldingManagement } from "@/components/add-data/useHoldingManagement";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CompleteImportData } from "@/types/addData";

interface ManualEntryStepProps {
  completeImportData: CompleteImportData;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  isCreatingHoldings: boolean;
}

export function ManualEntryStep({
  completeImportData,
  onCompleteDataUpdate,
  isCreatingHoldings,
}: ManualEntryStepProps) {
  const { holdings, addHolding, removeHolding, updateHolding } =
    useHoldingManagement({
      completeImportData,
      onCompleteDataUpdate,
    });

  const existingHoldingsList = holdings.filter((h) => h.isExisting);
  const newHoldingsList = holdings.filter((h) => !h.isExisting);

  // Helper to check if a holding is invalid
  const isHoldingInvalid = (holding: {
    tokenValue: string;
    amount: string;
  }): boolean => {
    if (!holding.tokenValue.trim()) return true;
    const amount = holding.amount.trim();
    if (!amount) return true;
    const numAmount = Number.parseFloat(amount);
    return Number.isNaN(numAmount) || numAmount <= 0;
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold mb-2">Manual Data Entry</h3>
        <p className="text-muted-foreground">
          Enter your holdings manually. You can add multiple holdings at once.
        </p>
      </div>

      {/* Existing Holdings Section - Only show for existing accounts */}
      {existingHoldingsList.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>Existing Holdings</span>
              <Badge variant="secondary">{existingHoldingsList.length}</Badge>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Update amounts for your existing holdings
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {existingHoldingsList.map((holding) => (
              <HoldingInputRow
                key={holding.id}
                id={holding.id}
                tokenValue={holding.tokenValue}
                amount={holding.amount}
                originalAmount={
                  "originalAmount" in holding
                    ? holding.originalAmount
                    : undefined
                }
                onTokenChange={(value) =>
                  updateHolding(holding.id, "tokenValue", value)
                }
                onAmountChange={(value) =>
                  updateHolding(holding.id, "amount", value)
                }
                onRemove={() => removeHolding(holding.id)}
                disabled={isCreatingHoldings}
                tokenDisabled={true}
                allowCreateNewToken={false}
                canRemove={false}
                placeholder="Select token..."
                hasError={isHoldingInvalid(holding)}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* New Holdings Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span>
              {existingHoldingsList.length > 0
                ? "Add New Holdings"
                : "Holdings"}
            </span>
            {newHoldingsList.length > 0 && (
              <Badge variant="secondary">{newHoldingsList.length}</Badge>
            )}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {existingHoldingsList.length > 0
              ? "Add additional holdings to this account"
              : "Add holdings to your new account"}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {newHoldingsList.map((holding) => (
            <HoldingInputRow
              key={holding.id}
              id={holding.id}
              tokenValue={holding.tokenValue}
              amount={holding.amount}
              onTokenChange={(value) =>
                updateHolding(holding.id, "tokenValue", value)
              }
              onAmountChange={(value) =>
                updateHolding(holding.id, "amount", value)
              }
              onRemove={() => removeHolding(holding.id)}
              disabled={isCreatingHoldings}
              canRemove={
                existingHoldingsList.length > 0 || newHoldingsList.length > 1
              }
              allowCreateNewToken={true}
              placeholder="Search tokens..."
              hasError={isHoldingInvalid(holding)}
            />
          ))}

          <Button
            type="button"
            variant="outline"
            onClick={addHolding}
            disabled={isCreatingHoldings}
          >
            Add Another Holding
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
