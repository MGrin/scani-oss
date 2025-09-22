import { useCallback, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { trpc } from "@/lib/trpc";

// Types for the parsing results based on backend ScreenshotParsingResult
interface ParsedHoldingWithValidation {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  notes?: string;
  tokenExists: boolean;
  tokenId?: string;
  suggestedTokenType?: string;
  errors: string[];
  warnings: string[];
  requiresUserSelection?: boolean;
  providerValidation?: {
    exactMatch?: {
      isValid: boolean;
      metadata?: {
        symbol: string;
        name: string;
        type: string;
        provider: string;
      };
    };
    similarMatches?: Array<{
      isValid: boolean;
      metadata?: {
        symbol: string;
        name: string;
        type: string;
        provider: string;
      };
    }>;
    noMatches?: boolean;
  };
}

interface ParsedPortfolio {
  holdings: Array<{
    symbol: string;
    name?: string;
    balance: string;
    confidence: number;
    notes?: string;
  }>;
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

interface AIProviderResponse {
  portfolio: ParsedPortfolio;
  metadata?: {
    model: string;
    tokensUsed?: number;
    processingTime?: number;
    [key: string]: unknown;
  };
}

interface Account {
  id: string;
  name: string;
  institutionName: string;
}

interface Summary {
  totalHoldings: number;
  existingTokens: number;
  newTokensRequired: number;
  averageConfidence: number;
  hasErrors: boolean;
  hasWarnings: boolean;
}

export interface ScreenshotParsingResult {
  aiResponse: AIProviderResponse;
  holdings: ParsedHoldingWithValidation[];
  account: Account;
  summary: Summary;
}

export interface MultipleScreenshotResult {
  results: ScreenshotParsingResult[];
  combinedHoldings: ParsedHoldingWithValidation[];
  overallSummary: {
    totalScreenshots: number;
    totalHoldings: number;
    existingTokens: number;
    newTokensRequired: number;
    averageConfidence: number;
    hasErrors: boolean;
    hasWarnings: boolean;
  };
  account: Account;
}

export interface ParsedHolding {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  notes?: string;
  tokenExists: boolean;
  tokenId?: string;
  suggestedTokenType?: string;
  errors: string[];
  warnings: string[];
  requiresUserSelection?: boolean;
  providerValidation?: {
    exactMatch?: {
      isValid: boolean;
      metadata?: {
        symbol: string;
        name: string;
        type: string;
        provider: string;
      };
    };
    similarMatches?: Array<{
      isValid: boolean;
      metadata?: {
        symbol: string;
        name: string;
        type: string;
        provider: string;
      };
    }>;
    noMatches?: boolean;
  };
}

export type ScreenshotState =
  | "upload"
  | "parsing"
  | "review"
  | "processing"
  | "success"
  | "error";

interface UseScreenshotParsingOptions {
  onSuccess?: () => void;
  onParsingComplete?: (result: ScreenshotParsingResult) => void;
  onMultipleParsingComplete?: (result: MultipleScreenshotResult) => void;
  allowMultiple?: boolean;
}

export function useScreenshotParsing({
  onSuccess,
  onParsingComplete,
  onMultipleParsingComplete,
  allowMultiple = false,
}: UseScreenshotParsingOptions = {}) {
  const [state, setState] = useState<ScreenshotState>("upload");
  const [parsingResults, setParsingResults] =
    useState<ScreenshotParsingResult | null>(null);
  const [multipleResults, setMultipleResults] =
    useState<MultipleScreenshotResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [retryCount, setRetryCount] = useState<number>(0);
  const [lastFailedOperation, setLastFailedOperation] = useState<
    "parsing" | "processing" | null
  >(null);
  const [processingProgress, setProcessingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const { toast } = useToast();

  const utils = trpc.useUtils();
  const parseScreenshot = trpc.screenshotParsing.parseScreenshot.useMutation();
  const processHoldingsMutation =
    trpc.screenshotParsing.processHoldingsFromParsing.useMutation({
      onSuccess: () => {
        // Invalidate all relevant queries after successful holdings creation
        utils.holdings.getAll.invalidate();
        utils.holdings.getUnpriceableTokens.invalidate(); // For unpriceable tokens notification
        utils.users.getPortfolioValue.invalidate();
        utils.tokens.getByUserId.invalidate();
        utils.accounts.getAll.invalidate(); // Account lists and balances
        utils.accounts.getSummaries.invalidate(); // Account summaries with portfolio values
      },
    });

  const handleImageUpload = useCallback(
    async (base64: string, _fileName: string, accountId: string) => {
      if (!accountId) {
        toast({
          title: "No account selected",
          description: "Please select an account first",
          variant: "destructive",
        });
        return;
      }

      setState("parsing");
      setErrorMessage("");

      try {
        const result = await parseScreenshot.mutateAsync({
          imageBase64: base64,
          accountId: accountId,
          context: "Processing holdings from screenshot (auto-create/update)",
        });

        if ("data" in result && result.data) {
          setParsingResults(result.data);
          setState("review");
          onParsingComplete?.(result.data);

          toast({
            title: "Screenshot analyzed successfully",
            description: `Found ${
              result.data.holdings.length
            } holdings with ${Math.round(
              result.data.summary.averageConfidence * 100
            )}% average confidence`,
          });
        } else if ("error" in result) {
          throw new Error(result.error || "Failed to parse screenshot");
        } else {
          throw new Error("Unexpected response format");
        }
      } catch (error) {
        console.error("Screenshot parsing failed:", error);

        // Provide more specific error messages and recovery suggestions
        let errorMessage = "Failed to analyze screenshot";
        let suggestions: string[] = [];

        if (error instanceof Error) {
          const message = error.message.toLowerCase();

          if (
            message.includes("network") ||
            message.includes("fetch") ||
            message.includes("timeout")
          ) {
            errorMessage =
              "Network error occurred while analyzing the screenshot";
            suggestions = [
              "Check your internet connection",
              "Try again in a few moments",
              "Try a different AI provider",
            ];
          } else if (
            message.includes("rate limit") ||
            message.includes("quota")
          ) {
            errorMessage = "AI provider rate limit exceeded";
            suggestions = [
              "Wait a few minutes before trying again",
              "Try a different AI provider",
              "Contact support if this persists",
            ];
          } else if (
            message.includes("invalid") ||
            message.includes("format")
          ) {
            errorMessage = "Image format not supported or corrupted";
            suggestions = [
              "Try uploading a different image format (PNG, JPEG)",
              "Ensure the image is not corrupted",
              "Make sure the image contains portfolio data",
            ];
          } else if (message.includes("size") || message.includes("large")) {
            errorMessage = "Image file is too large";
            suggestions = [
              "Compress the image to under 10MB",
              "Try uploading a smaller screenshot",
              "Use a different image format",
            ];
          } else {
            errorMessage = error.message;
            suggestions = [
              "Try uploading the image again",
              "Ensure the screenshot shows portfolio holdings clearly",
              "Try a different AI provider",
            ];
          }
        }

        setErrorMessage(
          `${errorMessage}\n\nSuggestions:\n• ${suggestions.join("\n• ")}`
        );
        setLastFailedOperation("parsing");
        setState("error");

        toast({
          title: "Parsing failed",
          description: errorMessage,
          variant: "destructive",
        });
      }
    },
    [parseScreenshot, toast, onParsingComplete]
  );

  // Helper function to combine multiple screenshot results
  const combineScreenshotResults = useCallback(
    (results: ScreenshotParsingResult[]): MultipleScreenshotResult => {
      const allHoldings = results.flatMap((r) => r.holdings);

      // Deduplicate holdings by symbol (keep the one with highest confidence)
      const holdingsMap = new Map<string, ParsedHoldingWithValidation>();

      allHoldings.forEach((holding) => {
        const existing = holdingsMap.get(holding.symbol);
        if (!existing || holding.confidence > existing.confidence) {
          holdingsMap.set(holding.symbol, holding);
        }
      });

      const combinedHoldings = Array.from(holdingsMap.values());

      const overallSummary = {
        totalScreenshots: results.length,
        totalHoldings: combinedHoldings.length,
        existingTokens: combinedHoldings.filter((h) => h.tokenExists).length,
        newTokensRequired: combinedHoldings.filter((h) => !h.tokenExists)
          .length,
        averageConfidence:
          combinedHoldings.reduce((sum, h) => sum + h.confidence, 0) /
            combinedHoldings.length || 0,
        hasErrors: combinedHoldings.some((h) => h.errors.length > 0),
        hasWarnings: combinedHoldings.some((h) => h.warnings.length > 0),
      };

      return {
        results,
        combinedHoldings,
        overallSummary,
        account: results[0]?.account || {
          id: "",
          name: "Unknown Account",
          institutionName: "Unknown Institution",
        }, // All should have the same account
      };
    },
    []
  );

  const handleMultipleImageUpload = useCallback(
    async (
      files: Array<{ base64: string; fileName: string }>,
      accountId: string
    ) => {
      if (!accountId) {
        toast({
          title: "No account selected",
          description: "Please select an account first",
          variant: "destructive",
        });
        return;
      }

      if (!allowMultiple) {
        toast({
          title: "Multiple uploads not supported",
          description: "This component only supports single file uploads",
          variant: "destructive",
        });
        return;
      }

      setState("parsing");
      setErrorMessage("");
      setProcessingProgress({ current: 0, total: files.length });

      const results: ScreenshotParsingResult[] = [];
      const errors: string[] = [];

      try {
        // Process files in parallel
        const parsePromises = files.map(async (file, index) => {
          if (!file) return null;

          const processFile = async () => {
            const result = await parseScreenshot.mutateAsync({
              imageBase64: file.base64,
              accountId: accountId,
              context: `Processing holdings from screenshot ${index + 1}/${
                files.length
              } (${file.fileName})`,
            });

            if ("data" in result && result.data) {
              return {
                success: true as const,
                data: result.data,
                fileName: file.fileName,
              };
            } else if ("error" in result) {
              return {
                success: false as const,
                error: `${file.fileName}: ${result.error || "Failed to parse"}`,
                fileName: file.fileName,
              };
            } else {
              return {
                success: false as const,
                error: `${file.fileName}: Unexpected response format`,
                fileName: file.fileName,
              };
            }
          };

          try {
            return await processFile();
          } catch (error) {
            console.error(`Error parsing ${file.fileName}:`, error);
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            return {
              success: false as const,
              error: `${file.fileName}: ${errorMsg}`,
              fileName: file.fileName,
            };
          }
        });

        // Wait for all parsing to complete
        const parseResults = await Promise.allSettled(parsePromises);

        // Process results from Promise.allSettled
        for (const settledResult of parseResults) {
          if (settledResult.status === "fulfilled") {
            const result = settledResult.value;
            if (!result) continue;

            if (result.success && result.data) {
              results.push(result.data);
            } else if (!result.success && result.error) {
              errors.push(result.error);
            }
          } else if (settledResult.status === "rejected") {
            // Handle promise rejection
            const error = settledResult.reason;
            const errorMsg =
              error instanceof Error ? error.message : "Unknown error";
            errors.push(`Promise rejected: ${errorMsg}`);
          }
        }

        // Combine results if we have any successful parses
        if (results.length > 0) {
          const combinedResult = combineScreenshotResults(results);
          setMultipleResults(combinedResult);
          setState("review");
          onMultipleParsingComplete?.(combinedResult);

          const successMessage = `Analyzed ${results.length}/${files.length} screenshots successfully`;
          const totalHoldings = combinedResult.combinedHoldings.length;

          toast({
            title: "Screenshots analyzed",
            description: `${successMessage}. Found ${totalHoldings} total holdings with ${Math.round(
              combinedResult.overallSummary.averageConfidence * 100
            )}% average confidence`,
            variant: errors.length > 0 ? "default" : "default",
          });

          if (errors.length > 0) {
            toast({
              title: `${errors.length} screenshots failed`,
              description:
                errors.slice(0, 3).join(", ") +
                (errors.length > 3 ? "..." : ""),
              variant: "destructive",
            });
          }
        } else {
          throw new Error(`All ${files.length} screenshots failed to parse`);
        }
      } catch (error) {
        console.error("Multiple screenshot parsing failed:", error);
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Failed to parse screenshots";

        setErrorMessage(errorMessage);
        setLastFailedOperation("parsing");
        setState("error");

        toast({
          title: "Parsing failed",
          description: errorMessage,
          variant: "destructive",
        });
      } finally {
        setProcessingProgress(null);
      }
    },
    [
      parseScreenshot,
      toast,
      onMultipleParsingComplete,
      allowMultiple,
      combineScreenshotResults,
    ]
  );

  const handleProcessHoldings = useCallback(
    async (processedHoldings?: ParsedHolding[], accountId?: string) => {
      // Determine holdings and account from parameters or current state
      const holdingsToProcess =
        processedHoldings ||
        multipleResults?.combinedHoldings ||
        parsingResults?.holdings ||
        [];
      const targetAccountId =
        accountId ||
        multipleResults?.account?.id ||
        parsingResults?.account?.id;

      if (!targetAccountId) {
        toast({
          title: "No account specified",
          description: "Unable to determine target account",
          variant: "destructive",
        });
        return;
      }

      if (holdingsToProcess.length === 0) {
        toast({
          title: "No holdings to process",
          description: "No holdings were found to process",
          variant: "destructive",
        });
        return;
      }

      setState("processing");
      setErrorMessage("");

      try {
        // Use the unified backend API that automatically determines create vs update
        const result = await processHoldingsMutation.mutateAsync({
          accountId: targetAccountId,
          holdings: holdingsToProcess,
          options: {
            createMissingTokens: true,
            skipValidation: false,
          },
        });

        if ("data" in result && result.data) {
          const { created, updated, errors } = result.data;

          console.log("Processing results:", {
            created: created.length,
            updated: updated.length,
            errors: errors.length,
            createdItems: created.map((c) => ({
              symbol: c.tokenSymbol,
              holdingId: c.holdingId,
            })),
            updatedItems: updated.map((u) => ({
              symbol: u.tokenSymbol,
              holdingId: u.holdingId,
              change: u.change,
            })),
            errorItems: errors.map((e) => ({
              symbol: e.symbol,
              error: e.error,
            })),
          });

          // Show success with combined results
          setState("success");

          let successMessage = "";
          if (created.length > 0 && updated.length > 0) {
            successMessage = `Created ${created.length} new holdings and updated ${updated.length} existing holdings`;
          } else if (created.length > 0) {
            successMessage = `Created ${created.length} new holdings`;
          } else if (updated.length > 0) {
            successMessage = `Updated ${updated.length} existing holdings`;
          } else {
            successMessage = "No holdings were processed";
          }

          if (errors.length > 0) {
            successMessage += ` with ${errors.length} errors. Check the results for details.`;
            console.warn("Processing completed with errors:", errors);
          }

          toast({
            title: "Holdings processed successfully",
            description: successMessage,
            ...(errors.length > 0 && { variant: "default" }),
          });

          // Log successful operations
          if (created.length > 0) {
            console.log(
              "Successfully created holdings:",
              created.map((c) => `${c.tokenSymbol} (${c.holdingId})`)
            );
          }
          if (updated.length > 0) {
            console.log(
              "Successfully updated holdings:",
              updated.map(
                (u) => `${u.tokenSymbol} (${u.holdingId}, change: ${u.change})`
              )
            );
          }

          // Navigate immediately after showing the success message, don't wait 2 seconds
          // The cache invalidation will ensure fresh data is loaded
          setTimeout(() => {
            onSuccess?.();
          }, 500);
        } else if ("error" in result) {
          throw new Error(result.error || "Failed to process holdings");
        }
      } catch (error) {
        console.error("Holdings processing failed:", error);

        // Provide more specific error messages for processing failures
        let errorMessage = "Failed to process holdings";
        let suggestions: string[] = [];

        if (error instanceof Error) {
          const message = error.message.toLowerCase();

          if (message.includes("token") && message.includes("not found")) {
            errorMessage = "Some tokens were not found in the database";
            suggestions = [
              'Enable "Create missing tokens" option',
              "Manually add missing tokens before processing",
              "Review and edit token symbols if they appear incorrect",
            ];
          } else if (
            message.includes("balance") ||
            message.includes("amount")
          ) {
            errorMessage = "Invalid balance amounts detected";
            suggestions = [
              "Review and correct any invalid balance amounts",
              "Ensure all amounts are positive numbers",
              "Remove holdings with zero balances if not needed",
            ];
          } else if (
            message.includes("permission") ||
            message.includes("unauthorized")
          ) {
            errorMessage =
              "Permission denied - you may not have access to this account";
            suggestions = [
              "Verify you have access to the selected account",
              "Try selecting a different account",
              "Contact support if you believe this is an error",
            ];
          } else if (
            message.includes("network") ||
            message.includes("connection")
          ) {
            errorMessage = "Network error while processing holdings";
            suggestions = [
              "Check your internet connection",
              "Try processing again",
              "The data may still be processing in the background",
            ];
          } else {
            errorMessage = error.message;
            suggestions = [
              "Review the extracted holdings for any issues",
              "Try processing again",
              "Contact support if this error persists",
            ];
          }
        }

        setErrorMessage(
          `${errorMessage}\n\nSuggestions:\n• ${suggestions.join("\n• ")}`
        );
        setLastFailedOperation("processing");
        setState("error");

        toast({
          title: "Processing failed",
          description: errorMessage,
          variant: "destructive",
        });
      }
    },
    [
      processHoldingsMutation,
      toast,
      onSuccess,
      multipleResults?.account?.id,
      multipleResults?.combinedHoldings,
      parsingResults?.account?.id,
      parsingResults?.holdings,
    ]
  );

  const handleRetry = useCallback(async () => {
    if (lastFailedOperation === "parsing") {
      // Retry parsing with exponential backoff for network errors
      const maxRetries = 3;
      const shouldAutoRetry =
        retryCount < maxRetries &&
        errorMessage.toLowerCase().includes("network");

      if (shouldAutoRetry) {
        const delay = Math.min(1000 * 2 ** retryCount, 5000); // Max 5 second delay
        setRetryCount((prev) => prev + 1);

        toast({
          title: `Retrying in ${delay / 1000} seconds...`,
          description: `Attempt ${retryCount + 2} of ${maxRetries + 1}`,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));

        setState("parsing");
        setErrorMessage("");

        // This will trigger the parsing again
        return;
      }
    }

    // Normal retry - reset to initial state
    setState(lastFailedOperation === "parsing" ? "upload" : "review");
    setErrorMessage("");
    setRetryCount(0);
    setLastFailedOperation(null);
    setParsingResults(null);
  }, [lastFailedOperation, retryCount, errorMessage, toast]);

  const handleReset = useCallback(() => {
    setState("upload");
    setParsingResults(null);
    setMultipleResults(null);
    setErrorMessage("");
    setRetryCount(0);
    setLastFailedOperation(null);
    setProcessingProgress(null);
  }, []);

  return {
    state,
    parsingResults,
    multipleResults,
    errorMessage,
    retryCount,
    lastFailedOperation,
    processingProgress,
    isParsing: parseScreenshot.isPending,
    isProcessing: processHoldingsMutation.isPending,
    handleImageUpload,
    handleMultipleImageUpload,
    handleProcessHoldings,
    handleRetry,
    handleReset,
    allowMultiple,
  };
}
