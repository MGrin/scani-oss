import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import type { CompleteImportData } from '@/types/addData';

interface BinanceApiKeyStepProps {
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  onNext: () => void;
}

export function BinanceApiKeyStep({ onCompleteDataUpdate, onNext }: BinanceApiKeyStepProps) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);

  // Use tRPC mutation for API key validation
  const validateKeysMutation = trpc.integrations.binance.validateKeys.useMutation({
    onSuccess: () => {
      // Clear sensitive data from inputs to prevent lingering in the UI
      setApiKey('');
      setApiSecret('');
      setIsSubmitted(true);

      showSuccess('Binance credentials validated and stored', 'Success');

      // Update form data and proceed
      onCompleteDataUpdate({
        accountSelection: { mode: 'select', selectedAccountId: undefined },
      });

      // Move to next step (account selection)
      setTimeout(() => {
        onNext();
      }, 500);
    },
    onError: (error) => {
      showError(new Error(error.message), 'Binance API Key Validation');
    },
  });

  const handleValidate = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      showError(new Error('Please enter both API Key and Secret'), 'Binance API Keys');
      return;
    }

    validateKeysMutation.mutate({
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Your Binance Account</CardTitle>
        <CardDescription>
          Enter your Binance API credentials to import your trading account holdings
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 space-y-2">
          <p className="text-sm font-semibold text-blue-900 dark:text-blue-100">
            How to get your API Keys:
          </p>
          <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-1 list-decimal list-inside">
            <li>
              Go to{' '}
              <a
                href="https://www.binance.com/en/user/settings/api-management"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                Binance API Management
              </a>
            </li>
            <li>Create a new API key (or use an existing one)</li>
            <li>Enable "Read" permission and disable "Enable Trading" for security</li>
            <li>Copy your API Key and Secret below</li>
          </ol>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="apiKey" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="apiKey"
              type="password"
              placeholder="Paste your Binance API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={validateKeysMutation.isPending || isSubmitted}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Your API Key is used only for this validation and is never logged or exposed
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="apiSecret" className="text-sm font-medium">
              API Secret
            </label>
            <Input
              id="apiSecret"
              type="password"
              placeholder="Paste your Binance API Secret"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              disabled={validateKeysMutation.isPending || isSubmitted}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Your Secret is encrypted and stored securely in our database
            </p>
          </div>
        </div>

        <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            ⚠️ <span className="font-semibold">Important:</span> Only use API keys with Read
            permissions. Never create API keys with Withdrawal or other sensitive permissions for
            third-party applications.
          </p>
        </div>

        {isSubmitted && (
          <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg p-3">
            <p className="text-sm text-green-800 dark:text-green-200">
              ✓ Your Binance credentials have been validated and stored securely
            </p>
          </div>
        )}

        <Button
          onClick={handleValidate}
          disabled={
            validateKeysMutation.isPending || !apiKey.trim() || !apiSecret.trim() || isSubmitted
          }
          className="w-full"
        >
          {validateKeysMutation.isPending ? 'Validating...' : 'Validate & Connect'}
        </Button>
      </CardContent>
    </Card>
  );
}
