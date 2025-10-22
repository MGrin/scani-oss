import { Trash2 } from "lucide-react";
import { NumericFormat } from "react-number-format";
import { TokenSearchableSelector } from "@/components/selectors/TokenSearchableSelector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface HoldingInputRowProps {
  id: string;
  tokenValue: string;
  amount: string;
  originalAmount?: string;
  onTokenChange: (value: string) => void;
  onAmountChange: (value: string) => void;
  onRemove: () => void;
  disabled?: boolean;
  canRemove?: boolean;
  tokenDisabled?: boolean;
  allowCreateNewToken?: boolean;
  initialSearchTerm?: string;
  placeholder?: string;
  // Optional metadata display
  confidence?: number;
  notes?: string;
  highlightBackground?: boolean;
  removeButtonText?: string;
  showTrashIcon?: boolean;
  buttonSize?: "default" | "sm" | "lg" | "icon";
  // Validation
  hasError?: boolean;
}

export function HoldingInputRow({
  id,
  tokenValue,
  amount,
  originalAmount,
  onTokenChange,
  onAmountChange,
  onRemove,
  disabled = false,
  canRemove = true,
  tokenDisabled = false,
  allowCreateNewToken = true,
  initialSearchTerm,
  placeholder,
  confidence,
  notes,
  highlightBackground = false,
  removeButtonText = "Remove",
  showTrashIcon = false,
  buttonSize = "default",
  hasError = false,
}: HoldingInputRowProps) {
  const getConfidenceColor = (conf?: number) => {
    if (!conf) return "text-muted-foreground";
    if (conf >= 0.8) return "text-green-600";
    if (conf >= 0.6) return "text-orange-600";
    return "text-red-600";
  };

  const hasTokenError = hasError && !tokenValue.trim();
  const hasAmountError =
    hasError &&
    (!amount.trim() ||
      Number.isNaN(Number.parseFloat(amount)) ||
      Number.parseFloat(amount) <= 0);

  const containerClassName = `border rounded-lg p-3 space-y-2 ${
    highlightBackground ? "bg-yellow-50 border-yellow-200" : ""
  } ${hasError ? "border-red-300 bg-red-50/30" : ""}`;

  return (
    <div className={containerClassName}>
      {/* Token selector and amount */}
      <div className="flex flex-col md:flex-row items-start md:items-end gap-4">
        <div className="w-full md:flex-1">
          <Label className={`text-sm ${hasTokenError ? "text-red-600" : ""}`}>
            Token {hasTokenError && <span className="text-red-600">*</span>}
          </Label>
          <div
            className={hasTokenError ? "ring-2 ring-red-500 rounded-md" : ""}
          >
            <TokenSearchableSelector
              value={tokenValue}
              onValueChange={onTokenChange}
              placeholder={placeholder || "Search tokens..."}
              disabled={disabled || tokenDisabled}
              allowCreateNew={allowCreateNewToken}
              initialSearchTerm={initialSearchTerm}
            />
          </div>
        </div>
        {originalAmount ? (
          <div className="w-full md:w-auto flex flex-col md:flex-row items-start md:items-end gap-2 md:gap-2">
            <div className="w-full md:w-32">
              <Label className="text-sm">Current</Label>
              <NumericFormat
                value={originalAmount}
                disabled={true}
                customInput={Input}
                className="bg-gray-50 h-10"
                thousandSeparator=","
                decimalSeparator="."
                decimalScale={8}
                allowNegative={false}
              />
            </div>
            <div className="hidden md:flex items-center justify-center pt-6">
              <span className="text-lg text-muted-foreground">→</span>
            </div>
            <div className="w-full md:w-32">
              <Label
                className={`text-sm ${hasAmountError ? "text-red-600" : ""}`}
              >
                New {hasAmountError && <span className="text-red-600">*</span>}
              </Label>
              <NumericFormat
                id={`amount-${id}`}
                value={amount}
                onValueChange={(values) => onAmountChange(values.value)}
                placeholder="0.00"
                disabled={disabled}
                customInput={Input}
                className={`h-10 ${
                  hasAmountError ? "ring-2 ring-red-500" : ""
                }`}
                thousandSeparator=","
                decimalSeparator="."
                decimalScale={8}
                allowNegative={false}
              />
            </div>
          </div>
        ) : (
          <div className="w-full md:w-40">
            <Label
              className={`text-sm ${hasAmountError ? "text-red-600" : ""}`}
            >
              Amount {hasAmountError && <span className="text-red-600">*</span>}
            </Label>
            <NumericFormat
              id={`amount-${id}`}
              value={amount}
              onValueChange={(values) => onAmountChange(values.value)}
              placeholder="0.00"
              disabled={disabled}
              customInput={Input}
              className={`h-10 ${hasAmountError ? "ring-2 ring-red-500" : ""}`}
              thousandSeparator=","
              decimalSeparator="."
              decimalScale={8}
              allowNegative={false}
            />
          </div>
        )}
      </div>

      {/* Second row: Remove button, confidence, and notes */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 flex-wrap">
          <Button
            type="button"
            variant="outline"
            size={buttonSize}
            onClick={onRemove}
            disabled={disabled || !canRemove}
            className={
              showTrashIcon
                ? "text-red-600 hover:text-red-700 hover:bg-red-50"
                : ""
            }
          >
            {showTrashIcon && <Trash2 className="w-4 h-4 mr-1" />}
            {removeButtonText}
          </Button>

          {confidence !== undefined && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Confidence:</span>
              <span
                className={`text-sm font-medium ${getConfidenceColor(
                  confidence
                )}`}
              >
                {Math.round(confidence * 100)}%
              </span>
            </div>
          )}
        </div>

        {notes && <div className="text-xs text-muted-foreground">{notes}</div>}
      </div>
    </div>
  );
}

// Export alias for backwards compatibility
export const HoldingInputRowWithIcon = HoldingInputRow;
