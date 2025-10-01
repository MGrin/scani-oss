import type {
  MultipleScreenshotResult,
  ScreenshotParsingResult,
  ParsedHolding as SharedParsedHolding,
} from '@scani/shared';
import { useCallback, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import type { RouterOutputs } from '@/lib/api-types';
import { withOptimisticHandlers } from '@/lib/cache/optimistic/entityManager';
import { refreshHoldingsViews } from '@/lib/cache/refresh';
import { withRetry } from '@/lib/retry';
import { trpc } from '@/lib/trpc';

// Re-export for local consumers expecting ParsedHolding from this module
export type ParsedHolding = SharedParsedHolding;

type ProcessHoldingsResult = RouterOutputs['screenshotParsing']['processHoldingsFromParsing'];
type ProcessedHoldingMeta = {
  holdingId?: string | null;
  tokenSymbol?: string | null;
  transactionId?: string | null;
  change?: string | null;
};

type ProcessHoldingsPayload = {
  created?: ProcessedHoldingMeta[];
  updated?: ProcessedHoldingMeta[];
};

export type ScreenshotState = 'upload' | 'parsing' | 'review' | 'processing' | 'success' | 'error';

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
  const [state, setState] = useState<ScreenshotState>('upload');
  const [parsingResults, setParsingResults] = useState<ScreenshotParsingResult | null>(null);
  const [multipleResults, setMultipleResults] = useState<MultipleScreenshotResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [retryCount, setRetryCount] = useState<number>(0);
  const [lastFailedOperation, setLastFailedOperation] = useState<'parsing' | 'processing' | null>(
    null
  );
  const [processingProgress, setProcessingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [finalizingMessage, setFinalizingMessage] = useState<string | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);

  const { toast } = useToast();

  const utils = trpc.useUtils();
  const parseScreenshot = trpc.screenshotParsing.parseScreenshot.useMutation();
  const processHoldingsMutation = trpc.screenshotParsing.processHoldingsFromParsing.useMutation(
    withOptimisticHandlers('screenshotProcessing', 'create', utils, {
      async onMutate(_input) {
        await Promise.all([
          utils.holdings.getAll.cancel(),
          utils.accounts.getSummaries.cancel(),
          utils.users.getPortfolioValue.cancel(),
        ]);

        return {
          holdingsAll: utils.holdings.getAll.getData(),
        };
      },
      async onError(_error, _variables, context) {
        if (context?.holdingsAll) {
          utils.holdings.getAll.setData(undefined, context.holdingsAll);
        }
      },
      async onSettled(result, _error, variables) {
        const response = result as ProcessHoldingsResult | undefined;
        const payload =
          response && (response as { success?: boolean }).success
            ? ((response as { data?: ProcessHoldingsPayload }).data ?? undefined)
            : undefined;

        const createdIds = (payload?.created ?? [])
          .map((entry) => entry.holdingId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const updatedIds = (payload?.updated ?? [])
          .map((entry) => entry.holdingId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const holdingIds = Array.from(new Set([...createdIds, ...updatedIds]));
        const accountId = variables.accountId ?? undefined;
        const account = accountId
          ? (utils.accounts.getById?.getData({ id: accountId }) ??
            utils.accounts.getAll.getData()?.find((candidate) => candidate.id === accountId))
          : undefined;
        const institutionIds = account?.institutionId ? [account.institutionId] : [];

        await refreshHoldingsViews(utils, {
          holdingIds,
          accountIds: variables.accountId ? [variables.accountId] : [],
          institutionIds,
          cascadeTransactions: true,
        });
      },
    })
  );

  const handleImageUpload = useCallback(
    async (base64: string, _fileName: string, accountId: string) => {
      if (!accountId) {
        toast({
          title: 'No account selected',
          description: 'Please select an account first',
          variant: 'destructive',
        });
        return;
      }

      setState('parsing');
      setErrorMessage('');

      try {
        const result = await withRetry(
          () =>
            parseScreenshot.mutateAsync({
              imageBase64: base64,
              accountId: accountId,
              context: 'Processing holdings from screenshot (auto-create/update)',
            }),
          {
            retries: 2,
            baseDelayMs: 1000,
            maxDelayMs: 5000,
            strategy: 'exponential',
            shouldRetry: (e, attempt) => {
              const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
              const networky =
                msg.includes('network') ||
                msg.includes('connection') ||
                msg.includes('timeout') ||
                msg.includes('fetch');
              if (networky) {
                toast({
                  title: 'Network issue, retrying...',
                  description: `Attempt ${attempt + 2} of 3`,
                });
              }
              return networky;
            },
          }
        );

        if ('data' in result && result.data) {
          setParsingResults(result.data);
          setState('review');
          onParsingComplete?.(result.data);

          toast({
            title: 'Screenshot analyzed successfully',
            description: `Found ${result.data.holdings.length} holdings with ${Math.round(
              result.data.summary.averageConfidence * 100
            )}% average confidence`,
          });
        } else if ('error' in result) {
          throw new Error(result.error || 'Failed to parse screenshot');
        } else {
          throw new Error('Unexpected response format');
        }
      } catch (error) {
        console.error('Screenshot parsing failed:', error);

        // Provide more specific error messages and recovery suggestions
        let errorMessage = 'Failed to analyze screenshot';
        let suggestions: string[] = [];

        if (error instanceof Error) {
          const message = error.message.toLowerCase();

          if (
            message.includes('network') ||
            message.includes('fetch') ||
            message.includes('timeout')
          ) {
            errorMessage = 'Network error occurred while analyzing the screenshot';
            suggestions = [
              'Check your internet connection',
              'Try again in a few moments',
              'Try a different AI provider',
            ];
          } else if (message.includes('rate limit') || message.includes('quota')) {
            errorMessage = 'AI provider rate limit exceeded';
            suggestions = [
              'Wait a few minutes before trying again',
              'Try a different AI provider',
              'Contact support if this persists',
            ];
          } else if (message.includes('invalid') || message.includes('format')) {
            errorMessage = 'Image format not supported or corrupted';
            suggestions = [
              'Try uploading a different image format (PNG, JPEG)',
              'Ensure the image is not corrupted',
              'Make sure the image contains portfolio data',
            ];
          } else if (message.includes('size') || message.includes('large')) {
            errorMessage = 'Image file is too large';
            suggestions = [
              'Compress the image to under 10MB',
              'Try uploading a smaller screenshot',
              'Use a different image format',
            ];
          } else {
            errorMessage = error.message;
            suggestions = [
              'Try uploading the image again',
              'Ensure the screenshot shows portfolio holdings clearly',
              'Try a different AI provider',
            ];
          }
        }

        setErrorMessage(`${errorMessage}\n\nSuggestions:\n• ${suggestions.join('\n• ')}`);
        setLastFailedOperation('parsing');
        setState('error');

        toast({
          title: 'Parsing failed',
          description: errorMessage,
          variant: 'destructive',
        });
      }
    },
    [parseScreenshot, toast, onParsingComplete]
  );

  // Helper function to combine multiple screenshot results
  const combineScreenshotResults = useCallback(
    (results: ScreenshotParsingResult[]): MultipleScreenshotResult => {
      const combinedHoldings = results.flatMap((result) =>
        result.holdings.map((holding) => ({ ...holding }))
      );

      const overallSummary = {
        totalScreenshots: results.length,
        totalHoldings: combinedHoldings.length,
        existingTokens: combinedHoldings.filter((h) => h.tokenExists).length,
        newTokensRequired: combinedHoldings.filter((h) => !h.tokenExists).length,
        averageConfidence:
          combinedHoldings.reduce((sum, h) => sum + h.confidence, 0) / combinedHoldings.length || 0,
        hasErrors: combinedHoldings.some((h) => h.errors.length > 0),
        hasWarnings: combinedHoldings.some((h) => h.warnings.length > 0),
      };

      return {
        results,
        combinedHoldings,
        overallSummary,
        account: results[0]?.account || {
          id: '',
          name: 'Unknown Account',
          institutionName: 'Unknown Institution',
        }, // All should have the same account
      };
    },
    []
  );

  const handleMultipleImageUpload = useCallback(
    async (files: Array<{ base64: string; fileName: string }>, accountId: string) => {
      if (!accountId) {
        toast({
          title: 'No account selected',
          description: 'Please select an account first',
          variant: 'destructive',
        });
        return;
      }

      if (!allowMultiple) {
        toast({
          title: 'Multiple uploads not supported',
          description: 'This component only supports single file uploads',
          variant: 'destructive',
        });
        return;
      }

      setState('parsing');
      setErrorMessage('');
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

            if ('data' in result && result.data) {
              return {
                success: true as const,
                data: result.data,
                fileName: file.fileName,
              };
            } else if ('error' in result) {
              return {
                success: false as const,
                error: `${file.fileName}: ${result.error || 'Failed to parse'}`,
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
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
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
          if (settledResult.status === 'fulfilled') {
            const result = settledResult.value;
            if (!result) continue;

            if (result.success && result.data) {
              results.push(result.data);
            } else if (!result.success && result.error) {
              errors.push(result.error);
            }
          } else if (settledResult.status === 'rejected') {
            // Handle promise rejection
            const error = settledResult.reason;
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            errors.push(`Promise rejected: ${errorMsg}`);
          }
        }

        // Combine results if we have any successful parses
        if (results.length > 0) {
          const combinedResult = combineScreenshotResults(results);
          setMultipleResults(combinedResult);
          setState('review');
          onMultipleParsingComplete?.(combinedResult);

          const successMessage = `Analyzed ${results.length}/${files.length} screenshots successfully`;
          const totalHoldings = combinedResult.combinedHoldings.length;

          toast({
            title: 'Screenshots analyzed',
            description: `${successMessage}. Found ${totalHoldings} total holdings with ${Math.round(
              combinedResult.overallSummary.averageConfidence * 100
            )}% average confidence`,
            variant: errors.length > 0 ? 'default' : 'default',
          });

          if (errors.length > 0) {
            toast({
              title: `${errors.length} screenshots failed`,
              description: errors.slice(0, 3).join(', ') + (errors.length > 3 ? '...' : ''),
              variant: 'destructive',
            });
          }
        } else {
          throw new Error(`All ${files.length} screenshots failed to parse`);
        }
      } catch (error) {
        console.error('Multiple screenshot parsing failed:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to parse screenshots';

        setErrorMessage(errorMessage);
        setLastFailedOperation('parsing');
        setState('error');

        toast({
          title: 'Parsing failed',
          description: errorMessage,
          variant: 'destructive',
        });
      } finally {
        setProcessingProgress(null);
      }
    },
    [parseScreenshot, toast, onMultipleParsingComplete, allowMultiple, combineScreenshotResults]
  );

  const waitForPricing = useCallback(
    async (symbols: string[]) => {
      const normalizedTargets = Array.from(new Set(symbols.map((symbol) => symbol.toUpperCase())));

      if (normalizedTargets.length === 0) {
        return true;
      }

      const initialUnpriceableSymbols = new Set(
        (utils.holdings.getUnpriceableTokens.getData()?.tokens ?? []).map((token) =>
          token.symbol.toUpperCase()
        )
      );

      const targets = normalizedTargets.filter((symbol) => !initialUnpriceableSymbols.has(symbol));

      if (targets.length === 0) {
        return true;
      }

      // Reduced to 3 attempts with smarter polling
      const maxAttempts = 3;

      const extractData = (result: unknown) => {
        if (result && typeof result === 'object' && 'data' in result) {
          return (result as { data: unknown }).data;
        }
        return result;
      };

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Fetch both queries in parallel
        const [portfolioResult, unpriceableResult] = await Promise.allSettled([
          utils.users.getPortfolioValue.fetch(),
          utils.holdings.getUnpriceableTokens.fetch(),
        ]);

        const portfolioData =
          portfolioResult.status === 'fulfilled' ? extractData(portfolioResult.value) : undefined;
        const unpriceableData =
          unpriceableResult.status === 'fulfilled'
            ? extractData(unpriceableResult.value)
            : undefined;

        const unpriceableSymbols = new Set<string>([
          ...initialUnpriceableSymbols,
          ...((unpriceableData as { tokens?: Array<{ symbol: string }> })?.tokens ?? []).map(
            (token) => token.symbol.toUpperCase()
          ),
        ]);

        const allTokensReady = targets.every((symbol) => {
          if (unpriceableSymbols.has(symbol)) {
            return true;
          }

          const holdings = (
            portfolioData as {
              holdings?: Array<{ tokenSymbol?: string; value?: string }>;
            }
          )?.holdings;

          const matchingHolding = holdings?.find(
            (holding) => holding.tokenSymbol?.toUpperCase() === symbol
          );

          if (!matchingHolding) {
            return false;
          }

          const numericValue = Number.parseFloat(matchingHolding.value ?? '0');
          if (!Number.isFinite(numericValue)) {
            return false;
          }

          return Math.abs(numericValue) > 0;
        });

        if (allTokensReady) {
          return true;
        }

        // Only wait if not the last attempt
        if (attempt < maxAttempts - 1) {
          // Progressive delay: 500ms, 1000ms, 1500ms
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }

      return false;
    },
    [utils.holdings.getUnpriceableTokens, utils.users.getPortfolioValue]
  );

  const handleProcessHoldings = useCallback(
    async (processedHoldings?: ParsedHolding[], accountId?: string) => {
      const holdingsToProcess =
        processedHoldings || multipleResults?.combinedHoldings || parsingResults?.holdings || [];
      const targetAccountId =
        accountId || multipleResults?.account?.id || parsingResults?.account?.id;

      if (!targetAccountId) {
        toast({
          title: 'No account specified',
          description: 'Unable to determine target account',
          variant: 'destructive',
        });
        return;
      }

      if (holdingsToProcess.length === 0) {
        toast({
          title: 'No holdings to process',
          description: 'No holdings were found to process',
          variant: 'destructive',
        });
        return;
      }

      setState('processing');
      setErrorMessage('');
      setFinalizingMessage('Submitting holdings...');
      setIsFinalizing(true);

      try {
        const rawResult = await processHoldingsMutation.mutateAsync({
          accountId: targetAccountId,
          holdings: holdingsToProcess,
          options: {
            createMissingTokens: true,
            skipValidation: false,
          },
        });

        const payload = (rawResult as { data?: unknown })?.data ?? rawResult;

        if (
          payload &&
          typeof payload === 'object' &&
          'error' in payload &&
          !('created' in payload)
        ) {
          throw new Error((payload as { error?: string }).error || 'Failed to process holdings');
        }

        if (!payload || typeof payload !== 'object') {
          throw new Error('Failed to process holdings');
        }

        const created = ((
          payload as {
            created?: Array<{
              holdingId: string;
              transactionId?: string;
              tokenSymbol: string;
            }>;
          }
        ).created ?? []) as Array<{
          holdingId: string;
          transactionId?: string;
          tokenSymbol: string;
        }>;

        const updated = ((
          payload as {
            updated?: Array<{
              holdingId: string;
              transactionId?: string;
              tokenSymbol: string;
              change: string;
            }>;
          }
        ).updated ?? []) as Array<{
          holdingId: string;
          transactionId?: string;
          tokenSymbol: string;
          change: string;
        }>;

        const errors = ((
          payload as {
            errors?: Array<{ symbol: string; error: string }>;
          }
        ).errors ?? []) as Array<{ symbol: string; error: string }>;

        const tokensToMonitor = Array.from(
          new Set([
            ...created.map((entry) => entry.tokenSymbol),
            ...updated.map((entry) => entry.tokenSymbol),
          ])
        );

        if (tokensToMonitor.length > 0) {
          setFinalizingMessage('Syncing live prices...');
          const pricingReady = await waitForPricing(tokensToMonitor);
          if (!pricingReady) {
            toast({
              title: 'Finishing live pricing',
              description:
                "We're still fetching live prices for a couple of tokens. Values will refresh automatically shortly.",
            });
          }
        }

        // The mutation's onSettled has triggered refreshHoldingsViews which invalidates
        // and refetches all related queries. Wait briefly to ensure updates propagate.
        // The Holdings page has refetchOnMount: 'always' so it will fetch fresh data.
        setFinalizingMessage('Finalizing...');
        await new Promise((resolve) => setTimeout(resolve, 500));

        setState('success');
        setFinalizingMessage(null);
        setIsFinalizing(false);

        console.log('Processing results:', {
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

        let successMessage = '';
        if (created.length > 0 && updated.length > 0) {
          successMessage = `Created ${created.length} new holdings and updated ${updated.length} existing holdings`;
        } else if (created.length > 0) {
          successMessage = `Created ${created.length} new holdings`;
        } else if (updated.length > 0) {
          successMessage = `Updated ${updated.length} existing holdings`;
        } else {
          successMessage = 'No holdings were processed';
        }

        if (errors.length > 0) {
          successMessage += ` with ${errors.length} errors. Check the results for details.`;
          console.warn('Processing completed with errors:', errors);
        }

        toast({
          title: 'Holdings processed successfully',
          description: successMessage,
          ...(errors.length > 0 && { variant: 'default' }),
        });

        if (created.length > 0) {
          console.log(
            'Successfully created holdings:',
            created.map((c) => `${c.tokenSymbol} (${c.holdingId})`)
          );
        }
        if (updated.length > 0) {
          console.log(
            'Successfully updated holdings:',
            updated.map((u) => `${u.tokenSymbol} (${u.holdingId}, change: ${u.change})`)
          );
        }

        // Brief delay to ensure state updates before navigation
        setTimeout(() => {
          onSuccess?.();
        }, 100);
      } catch (error) {
        console.error('Holdings processing failed:', error);

        setFinalizingMessage(null);
        setIsFinalizing(false);

        let errorMessage = 'Failed to process holdings';
        let suggestions: string[] = [];

        if (error instanceof Error) {
          const message = error.message.toLowerCase();

          if (message.includes('token') && message.includes('not found')) {
            errorMessage = 'Some tokens were not found in the database';
            suggestions = [
              'Enable "Create missing tokens" option',
              'Manually add missing tokens before processing',
              'Review and edit token symbols if they appear incorrect',
            ];
          } else if (message.includes('balance') || message.includes('amount')) {
            errorMessage = 'Invalid balance amounts detected';
            suggestions = [
              'Review and correct any invalid balance amounts',
              'Ensure all amounts are positive numbers',
              'Remove holdings with zero balances if not needed',
            ];
          } else if (message.includes('permission') || message.includes('unauthorized')) {
            errorMessage = 'Permission denied - you may not have access to this account';
            suggestions = [
              'Verify you have access to the selected account',
              'Try selecting a different account',
              'Contact support if you believe this is an error',
            ];
          } else if (message.includes('network') || message.includes('connection')) {
            errorMessage = 'Network error while processing holdings';
            suggestions = [
              'Check your internet connection',
              'Try processing again',
              'The data may still be processing in the background',
            ];
          } else {
            errorMessage = error.message;
            suggestions = [
              'Review the extracted holdings for any issues',
              'Try processing again',
              'Contact support if this error persists',
            ];
          }
        }

        setErrorMessage(`${errorMessage}\n\nSuggestions:\n• ${suggestions.join('\n• ')}`);
        setLastFailedOperation('processing');
        setState('error');

        toast({
          title: 'Processing failed',
          description: errorMessage,
          variant: 'destructive',
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
      waitForPricing,
    ]
  );

  const handleRetry = useCallback(async () => {
    if (lastFailedOperation === 'parsing') {
      // Retry parsing with exponential backoff for network errors
      const maxRetries = 3;
      const shouldAutoRetry =
        retryCount < maxRetries && errorMessage.toLowerCase().includes('network');

      if (shouldAutoRetry) {
        // Use withRetry to perform a single delayed retry attempt with consistent backoff
        const nextAttempt = retryCount + 1;
        const delayMs = Math.min(1000 * 2 ** retryCount, 5000);
        setRetryCount(nextAttempt);

        toast({
          title: `Retrying in ${Math.round(delayMs / 1000)} seconds...`,
          description: `Attempt ${nextAttempt + 1} of ${maxRetries + 1}`,
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        setState('parsing');
        setErrorMessage('');

        // No direct call here, flow resumes where user initiated
        return;
      }
    }

    // Normal retry - reset to initial state
    setState(lastFailedOperation === 'parsing' ? 'upload' : 'review');
    setErrorMessage('');
    setRetryCount(0);
    setLastFailedOperation(null);
    setParsingResults(null);
    setFinalizingMessage(null);
    setIsFinalizing(false);
  }, [lastFailedOperation, retryCount, errorMessage, toast]);

  const handleReset = useCallback(() => {
    setState('upload');
    setParsingResults(null);
    setMultipleResults(null);
    setErrorMessage('');
    setRetryCount(0);
    setLastFailedOperation(null);
    setProcessingProgress(null);
    setFinalizingMessage(null);
    setIsFinalizing(false);
  }, []);

  const isBusy =
    parseScreenshot.isPending ||
    processHoldingsMutation.isPending ||
    isFinalizing ||
    state === 'processing';

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
    isFinalizing,
    finalizingMessage,
    isBusy,
    handleImageUpload,
    handleMultipleImageUpload,
    handleProcessHoldings,
    handleRetry,
    handleReset,
    allowMultiple,
  };
}
