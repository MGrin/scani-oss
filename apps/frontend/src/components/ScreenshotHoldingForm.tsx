import { AlertCircle, ArrowLeft, CheckCircle, Info } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { ParsingResultsReview } from './ParsingResultsReview';
import { ScreenshotUpload } from './ScreenshotUpload';
import { AccountFilterSelector } from './selectors/SearchableSelectors';
import { Alert, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

interface ScreenshotHoldingFormProps {
  accountId?: string;
  onAccountSelect?: (accountId: string) => void;
  onSuccess?: () => void;
  onCancel?: () => void;
  title?: string;
  description?: string;
}

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

interface ScreenshotParsingResult {
  aiResponse: AIProviderResponse;
  holdings: ParsedHoldingWithValidation[];
  account: Account;
  summary: Summary;
}

type FormState =
  | 'account-selection'
  | 'screenshot-upload'
  | 'parsing'
  | 'review'
  | 'processing'
  | 'success'
  | 'error';

interface ParsedHolding {
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
}

export function ScreenshotHoldingForm({
  accountId,
  onAccountSelect,
  onSuccess,
  onCancel,
  title = 'Add Holdings from Screenshot',
  description = 'Upload a screenshot of your portfolio and our AI will automatically extract holding data for you.',
}: ScreenshotHoldingFormProps) {
  const [state, setState] = useState<FormState>(
    accountId ? 'screenshot-upload' : 'account-selection'
  );
  const [selectedAccountId, setSelectedAccountId] = useState<string>(accountId || '');

  const [parsingResults, setParsingResults] = useState<ScreenshotParsingResult | null>(null);

  const [errorMessage, setErrorMessage] = useState<string>('');
  const [retryCount, setRetryCount] = useState<number>(0);
  const [lastFailedOperation, setLastFailedOperation] = useState<'parsing' | 'processing' | null>(
    null
  );

  const { toast } = useToast();

  const parseScreenshot = trpc.screenshotParsing.parseScreenshot.useMutation();
  const processHoldingsMutation = trpc.screenshotParsing.processHoldingsFromParsing.useMutation();

  const { data: accounts } = trpc.accounts.getAll.useQuery();

  const handleAccountSelect = useCallback(
    (accountId: string) => {
      setSelectedAccountId(accountId);
      onAccountSelect?.(accountId);
      setState('screenshot-upload');
    },
    [onAccountSelect]
  );

  const handleImageUpload = useCallback(
    async (base64: string, _fileName: string) => {
      if (!selectedAccountId) {
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
        const result = await parseScreenshot.mutateAsync({
          imageBase64: base64,
          accountId: selectedAccountId,
          context: 'Processing holdings from screenshot (auto-create/update)',
        });

        if ('data' in result && result.data) {
          setParsingResults(result.data);
          setState('review');

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
    [selectedAccountId, parseScreenshot, toast]
  );

  const handleProcessHoldings = useCallback(
    async (processedHoldings: ParsedHolding[]) => {
      if (!selectedAccountId) return;

      setState('processing');
      setErrorMessage('');

      try {
        // Use the unified backend API that automatically determines create vs update
        const result = await processHoldingsMutation.mutateAsync({
          accountId: selectedAccountId,
          holdings: processedHoldings,
          options: {
            createMissingTokens: true,
            skipValidation: false,
          },
        });

        if ('data' in result && result.data) {
          const { created, updated, errors } = result.data;

          // Show success with combined results
          setState('success');

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
          }

          toast({
            title: 'Holdings processed successfully',
            description: successMessage,
            ...(errors.length > 0 && { variant: 'default' }),
          });

          setTimeout(() => {
            onSuccess?.();
          }, 2000);
        } else if ('error' in result) {
          throw new Error(result.error || 'Failed to process holdings');
        }
      } catch (error) {
        console.error('Holdings processing failed:', error);

        // Provide more specific error messages for processing failures
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
    [selectedAccountId, processHoldingsMutation, toast, onSuccess]
  );

  const handleRetry = useCallback(async () => {
    if (lastFailedOperation === 'parsing') {
      // Retry parsing with exponential backoff for network errors
      const maxRetries = 3;
      const shouldAutoRetry =
        retryCount < maxRetries && errorMessage.toLowerCase().includes('network');

      if (shouldAutoRetry) {
        const delay = Math.min(1000 * 2 ** retryCount, 5000); // Max 5 second delay
        setRetryCount((prev) => prev + 1);

        toast({
          title: `Retrying in ${delay / 1000} seconds...`,
          description: `Attempt ${retryCount + 2} of ${maxRetries + 1}`,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));

        setState('parsing');
        setErrorMessage('');

        // This will trigger the parsing again
        return;
      }
    }

    // Normal retry - reset to initial state
    setState(lastFailedOperation === 'parsing' ? 'screenshot-upload' : 'review');
    setErrorMessage('');
    setRetryCount(0);
    setLastFailedOperation(null);
    setParsingResults(null);
  }, [lastFailedOperation, retryCount, errorMessage, toast]);

  const handleBack = useCallback(() => {
    if (state === 'review') {
      setState('screenshot-upload');
    } else if (state === 'screenshot-upload') {
      setState('account-selection');
    }
  }, [state]);

  const handleReset = useCallback(() => {
    setState(accountId ? 'screenshot-upload' : 'account-selection');
    setSelectedAccountId(accountId || '');
    setParsingResults(null);
    setErrorMessage('');
    setRetryCount(0);
    setLastFailedOperation(null);
  }, [accountId]);

  // Helper function to get current step information
  const getCurrentStepInfo = () => {
    switch (state) {
      case 'account-selection':
        return {
          title: 'Select Account',
          description: 'Choose an account where you want to process holdings from the screenshot.',
          showBack: false,
        };
      case 'screenshot-upload':
        return {
          title: title,
          description: description,
          showBack: !accountId, // Show back button only if we can go back to account selection
        };
      case 'parsing':
        return {
          title: 'Analyzing Screenshot',
          description: 'Our AI is extracting holding information from your screenshot.',
          showBack: false,
        };
      case 'review':
        return {
          title: 'Review Holdings',
          description: 'Review and confirm the extracted holdings before processing.',
          showBack: true,
        };
      case 'processing':
        return {
          title: 'Processing Holdings',
          description: 'Creating or updating your holdings.',
          showBack: false,
        };
      case 'success':
        return {
          title: 'Holdings Processed Successfully!',
          description: 'Your holdings have been created or updated.',
          showBack: false,
        };
      case 'error':
        return {
          title: 'Processing Error',
          description: 'There was an issue processing your request.',
          showBack: true,
        };
      default:
        return {
          title: title,
          description: description,
          showBack: false,
        };
    }
  };

  const stepInfo = getCurrentStepInfo();

  // Common header component
  const renderHeader = () => (
    <DialogHeader>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {stepInfo.showBack && (
            <Button variant="ghost" size="sm" onClick={handleBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <div>
            <DialogTitle>{stepInfo.title}</DialogTitle>
          </div>
        </div>
      </div>
      <DialogDescription>{stepInfo.description}</DialogDescription>
    </DialogHeader>
  );

  if (state === 'account-selection') {
    return (
      <div className="space-y-6">
        {renderHeader()}
        <div className="space-y-4">
          <AccountFilterSelector
            value={selectedAccountId}
            onValueChange={(value: string) => {
              if (value && value !== 'all') {
                handleAccountSelect(value);
              }
            }}
            accounts={accounts}
            placeholder="Search accounts..."
            includeAllOption={false}
          />

          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'screenshot-upload') {
    return (
      <div className="space-y-6">
        {renderHeader()}
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium mb-2 block">Processing Mode</div>
            <div className="flex space-x-2">
              <Badge variant="default">Auto Create/Update</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              System will automatically create new holdings or update existing ones based on what's
              already in the account
            </p>
          </div>
        </div>

        <ScreenshotUpload
          onImageUpload={handleImageUpload}
          disabled={parseScreenshot.isPending}
          acceptedFormats={['image/png', 'image/jpeg', 'image/jpg']}
          maxSizeMB={10}
        />

        {parseScreenshot.isPending && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              Analyzing screenshot with AI... This may take a moment.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end space-x-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (state === 'parsing') {
    return (
      <div className="space-y-6">
        {renderHeader()}
        <div className="py-8">
          <div className="text-center space-y-4">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
            <div className="space-y-2">
              <p className="text-muted-foreground">Using AI to extract holding information...</p>
              <div className="text-sm text-muted-foreground space-y-1 mt-4">
                <p>• Reading portfolio holdings and balances</p>
                <p>• Validating token symbols and amounts</p>
                <p>• Calculating confidence scores</p>
              </div>
              <div className="mt-4 p-3 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">
                  This usually takes 10-30 seconds depending on image complexity and AI provider
                  response time.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'review' && parsingResults) {
    return (
      <div className="space-y-6">
        {renderHeader()}

        <ParsingResultsReview
          portfolio={{
            holdings: parsingResults.holdings,
            overallConfidence: parsingResults.summary.averageConfidence,
            context: parsingResults.aiResponse.portfolio.context || undefined,
          }}
          account={parsingResults.account}
          summary={parsingResults.summary}
          aiMetadata={{
            provider: parsingResults.aiResponse.metadata?.model || 'unknown',
            model: parsingResults.aiResponse.metadata?.model || 'unknown',
            processingTime: parsingResults.aiResponse.metadata?.processingTime || 0,
          }}
          onApprove={(holdings, _options) => handleProcessHoldings(holdings)}
          onCancel={handleRetry}
          isProcessing={processHoldingsMutation.isPending}
        />
      </div>
    );
  }

  if (state === 'processing') {
    return (
      <div className="py-8">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <div>
            <h3 className="text-lg font-semibold">Processing Holdings</h3>
            <p className="text-muted-foreground">Processing holdings and transactions...</p>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="py-8">
        <div className="text-center space-y-4">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
          <div>
            <h3 className="text-lg font-semibold text-green-700">
              Holdings Processed Successfully!
            </h3>
            <p className="text-muted-foreground">
              Holdings have been created or updated based on your screenshot
            </p>
          </div>

          <div className="flex justify-center space-x-2">
            <Button onClick={handleReset}>Process More Holdings</Button>
            <Button variant="outline" onClick={onSuccess}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    const isNetworkError = errorMessage.toLowerCase().includes('network');
    const canAutoRetry = isNetworkError && retryCount < 3;

    return (
      <div className="py-8">
        <div className="text-center space-y-4">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-destructive">
              {lastFailedOperation === 'parsing'
                ? 'Screenshot Analysis Failed'
                : 'Holdings Processing Failed'}
            </h3>
            <div className="text-sm text-muted-foreground whitespace-pre-line">{errorMessage}</div>

            {retryCount > 0 && (
              <div className="p-2 bg-muted/50 rounded-lg">
                <p className="text-xs text-muted-foreground">Retry attempts: {retryCount}/3</p>
              </div>
            )}
          </div>

          <div className="flex justify-center space-x-2">
            <Button onClick={handleRetry} disabled={canAutoRetry}>
              {canAutoRetry ? 'Auto-retrying...' : 'Try Again'}
            </Button>
            <Button variant="outline" onClick={handleReset}>
              Start Over
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
