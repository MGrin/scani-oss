import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import type { CompleteImportData } from '@/types/addData';

// Props interface kept for consistency with other step components
// Navigation is handled internally by redirecting to /holdings
interface KrakenApiKeyStepProps {
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  onNext: () => void;
}

interface ImportResult {
  success: boolean;
  message: string;
  accounts: Array<{
    id: string;
    name: string;
    accountType: string;
  }>;
  holdings: Array<{
    id: string;
    accountId: string;
    tokenSymbol: string;
    balance: string;
  }>;
  accountsCreated: number;
  tokensImported: number;
  errors: Array<{
    accountType: string;
    error: string;
  }>;
}

export function KrakenApiKeyStep(_props: KrakenApiKeyStepProps) {
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // Use tRPC mutation for API key validation
  const validateKeysMutation = trpc.integrations.kraken.validateKeys.useMutation({
    onSuccess: (data: ImportResult) => {
      // Clear sensitive data from inputs to prevent lingering in the UI
      setApiKey('');
      setApiSecret('');
      setImportResult(data);

      const hasErrors = data.errors && data.errors.length > 0;
      const hasSuccess = data.tokensImported > 0;

      if (hasSuccess) {
        if (hasErrors) {
          showSuccess(
            `Imported ${data.tokensImported} tokens from ${data.accountsCreated} accounts. Some errors occurred.`,
            'Kraken Import'
          );
        } else {
          showSuccess(
            `Successfully imported ${data.tokensImported} tokens from ${data.accountsCreated} accounts`,
            'Kraken Import'
          );
        }
      } else {
        if (hasErrors) {
          showError('Failed to import Kraken accounts. See error details below.', 'Kraken Import');
        } else {
          showError('No tokens found in your Kraken accounts', 'Kraken Import');
        }
      }
    },
    onError: (error) => {
      showError(new Error(error.message), 'Kraken API Key Validation');
    },
  });

  const handleValidate = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      showError(new Error('Please enter both API Key and Secret'), 'Kraken API Keys');
      return;
    }

    validateKeysMutation.mutate({
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
    });
  };

  const handleReset = () => {
    setApiKey('');
    setApiSecret('');
    setImportResult(null);
  };

  // Render import results
  if (importResult) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-6 w-6 text-green-500" />
              <CardTitle>Kraken Import Complete</CardTitle>
            </div>
            <CardDescription>
              Your Kraken accounts have been successfully imported to Scani
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {importResult.accountsCreated}
                  </div>
                  <div className="text-sm text-muted-foreground">Accounts</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {importResult.tokensImported}
                  </div>
                  <div className="text-sm text-muted-foreground">Tokens</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {importResult.holdings.length}
                  </div>
                  <div className="text-sm text-muted-foreground">Holdings</div>
                </CardContent>
              </Card>
            </div>

            {/* Accounts created */}
            {importResult.accounts.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-semibold">Accounts Created</h4>
                <div className="space-y-2">
                  {importResult.accounts.map((account) => (
                    <Card key={account.id}>
                      <CardContent className="p-3 flex items-center justify-between">
                        <div>
                          <div className="font-medium">{account.name}</div>
                          <div className="text-sm text-muted-foreground">{account.accountType}</div>
                        </div>
                        <Badge variant="secondary">Kraken</Badge>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Errors */}
            {importResult.errors && importResult.errors.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Partial Import - Some Accounts Failed</AlertTitle>
                <AlertDescription>
                  <div className="mt-2 space-y-2">
                    {importResult.errors.map((error, index) => (
                      <details key={`${error.accountType}-${index}`} className="text-sm">
                        <summary className="cursor-pointer font-medium">
                          {error.accountType} Account
                        </summary>
                        <div className="mt-1 pl-4 text-xs font-mono bg-destructive/10 p-2 rounded">
                          {error.error}
                        </div>
                      </details>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button onClick={handleReset} variant="outline" className="flex-1">
                Connect Another Account
              </Button>
              <Button
                onClick={() => {
                  navigate('/holdings');
                }}
                className="flex-1"
              >
                View Holdings
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Render loading state during import
  if (validateKeysMutation.isPending) {
    return (
      <Card>
        <CardContent className="p-8">
          <div className="space-y-6 text-center">
            <div className="flex justify-center">
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary" />
            </div>
            <div>
              <h3 className="text-xl font-semibold mb-2">Importing Your Kraken Accounts</h3>
              <p className="text-muted-foreground">
                Validating credentials and fetching your holdings...
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Main input form
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Your Kraken Account</CardTitle>
        <CardDescription>
          Enter your Kraken API credentials to import your trading account holdings
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
                href="https://www.kraken.com/u/security/api"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium"
              >
                Kraken API Settings
              </a>
            </li>
            <li>Create a new API key (or use an existing one)</li>
            <li>Enable "Query Funds" permission and disable trading permissions for security</li>
            <li>Copy your API Key and Private Key (Secret) below</li>
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
              placeholder="Paste your Kraken API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={validateKeysMutation.isPending}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Your API Key is used only for this validation and is never logged or exposed
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="apiSecret" className="text-sm font-medium">
              Private Key (Secret)
            </label>
            <Input
              id="apiSecret"
              type="password"
              placeholder="Paste your Kraken Private Key"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              disabled={validateKeysMutation.isPending}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Your Private Key is encrypted and stored securely in our database
            </p>
          </div>
        </div>

        <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            ⚠️ <span className="font-semibold">Important:</span> Only use API keys with Query Funds
            permissions. Never create API keys with Withdrawal or Trading permissions for
            third-party applications.
          </p>
        </div>

        <Button
          onClick={handleValidate}
          disabled={validateKeysMutation.isPending || !apiKey.trim() || !apiSecret.trim()}
          className="w-full"
        >
          {validateKeysMutation.isPending ? 'Validating & Importing...' : 'Validate & Import'}
        </Button>
      </CardContent>
    </Card>
  );
}
