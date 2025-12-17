/**
 * PlaidLinkStep Component
 *
 * Component for connecting bank accounts via Plaid Link.
 * Provides a simple interface to initiate Plaid Link flow and handles the results.
 */

import { AlertCircle, Building2, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { showError, showSuccess } from '@/hooks/use-toast';
import { type PlaidSuccessResult, usePlaidLink } from '@/hooks/usePlaidLink';
import type { CompleteImportData } from '@/types/addData';

interface PlaidLinkStepProps {
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
  onNext: () => void;
}

export function PlaidLinkStep(_props: PlaidLinkStepProps) {
  const navigate = useNavigate();
  const [importResult, setImportResult] = useState<PlaidSuccessResult | null>(null);

  const { open, ready, loading, error, clearError } = usePlaidLink({
    onSuccess: (result) => {
      setImportResult(result);

      const hasErrors = result.errors && result.errors.length > 0;
      const hasSuccess = result.holdingsImported > 0;

      if (hasSuccess) {
        if (hasErrors) {
          showSuccess(
            `Imported ${result.holdingsImported} balances from ${result.accountsCreated} accounts. Some errors occurred.`,
            'Bank Connection Success'
          );
        } else {
          showSuccess(
            `Successfully imported ${result.holdingsImported} balances from ${result.accountsCreated} accounts`,
            'Bank Connection Success'
          );
        }
      } else {
        if (hasErrors) {
          showError(
            'Failed to import bank accounts. See error details below.',
            'Bank Connection Failed'
          );
        } else {
          showError('No accounts found', 'Bank Connection');
        }
      }
    },
    onExit: (err) => {
      if (err) {
        showError(err.error_message || 'Connection was cancelled', 'Bank Connection Cancelled');
      }
    },
  });

  const handleConnect = () => {
    clearError();
    open();
  };

  const handleViewAccounts = () => {
    navigate('/holdings');
  };

  const handleConnectAnother = () => {
    setImportResult(null);
    clearError();
    open();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Connect Your Bank Account
          </CardTitle>
          <CardDescription>
            Securely connect your bank account using Plaid to automatically import balances
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Info Alert */}
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Secure Connection</AlertTitle>
            <AlertDescription>
              Plaid uses bank-level security to connect your accounts. Your credentials are never
              stored on Scani servers.
            </AlertDescription>
          </Alert>

          {/* Error Display */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success Display */}
          {!importResult && !error && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                <p className="mb-2">What you'll get:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Automatic account detection</li>
                  <li>Real-time balance updates</li>
                  <li>Support for checking, savings, and credit accounts</li>
                  <li>Secure, read-only access</li>
                </ul>
              </div>

              <Button
                onClick={handleConnect}
                disabled={!ready || loading}
                className="w-full"
                size="lg"
              >
                {loading ? (
                  'Connecting...'
                ) : !ready ? (
                  'Loading...'
                ) : (
                  <>
                    <Building2 className="mr-2 h-4 w-4" />
                    Connect Bank Account
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Import Results */}
          {importResult && (
            <div className="space-y-4">
              {/* Success Summary */}
              <Alert className="border-green-500 bg-green-50">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertTitle className="text-green-900">Connection Successful!</AlertTitle>
                <AlertDescription className="text-green-800">
                  Your bank account has been connected to Scani
                </AlertDescription>
              </Alert>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{importResult.accountsCreated}</div>
                    <p className="text-xs text-muted-foreground">Accounts Connected</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{importResult.holdingsImported}</div>
                    <p className="text-xs text-muted-foreground">Balances Imported</p>
                  </CardContent>
                </Card>
              </div>

              {/* Institution Info */}
              {importResult.institutionCreated && (
                <div className="text-sm text-muted-foreground">
                  <Badge variant="secondary">New Institution Added</Badge>
                </div>
              )}

              {/* Errors Display */}
              {importResult.errors && importResult.errors.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Some Issues Occurred</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc list-inside space-y-1 mt-2">
                      {importResult.errors.map((error) => (
                        <li key={error} className="text-sm">
                          {error}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                <Button onClick={handleViewAccounts} className="flex-1" size="lg">
                  View Accounts
                </Button>
                <Button
                  onClick={handleConnectAnother}
                  variant="outline"
                  className="flex-1"
                  size="lg"
                  disabled={loading}
                >
                  Connect Another
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Additional Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">About Plaid</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Plaid is a secure service used by thousands of apps to connect to your financial
            accounts.
          </p>
          <p>
            Scani only receives read-only access to your account balances. We cannot move money or
            make changes to your accounts.
          </p>
          <p className="text-xs">
            Your credentials are encrypted and never stored on Scani servers.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
