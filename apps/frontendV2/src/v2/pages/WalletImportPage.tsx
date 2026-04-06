import { ArrowLeft, Loader2, Search, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

type Step = 'input' | 'detect' | 'result';

export function WalletImportPage() {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [step, setStep] = useState<Step>('input');
  const navigate = useNavigate();

  const detectMutation = trpc.wallet.detectChains.useMutation({
    onSuccess: () => setStep('detect'),
    onError: (err) => showError(err, 'Detecting chains'),
  });

  const importMutation = trpc.wallet.importAddress.useMutation({
    onSuccess: (result) => {
      setStep('result');
      showSuccess(
        `Imported ${result.holdings?.length ?? 0} holdings across ${result.accounts?.length ?? 0} accounts`
      );
    },
    onError: (err) => showError(err, 'Importing wallet'),
  });

  const handleDetect = () => {
    if (!address.trim()) return;
    detectMutation.mutate({ address: address.trim() });
  };

  const handleImport = () => {
    importMutation.mutate({
      address: address.trim(),
      displayName: displayName.trim() || undefined,
    });
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to={V2_ROUTES.addData}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Add Data
          </Link>
        </Button>
        <h2 className="text-2xl font-bold tracking-tight">Import Crypto Wallet</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Enter a wallet address to auto-detect chains and import balances
        </p>
      </div>

      {step === 'input' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Wallet Address</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x... or bc1... or any blockchain address"
              className="font-mono text-sm"
            />
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (optional)"
            />
            <Button onClick={handleDetect} disabled={!address.trim() || detectMutation.isPending}>
              {detectMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Detecting...
                </>
              ) : (
                <>
                  <Search className="h-4 w-4 mr-2" />
                  Detect Chains
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'detect' && detectMutation.data && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detected Chains</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 mb-4">
                {detectMutation.data.chainsDetected?.map((chain) => (
                  <Badge key={String(chain.chainId)} variant="secondary">
                    {chain.name}
                  </Badge>
                ))}
              </div>
              {detectMutation.data.chainsDetected?.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No supported chains detected for this address.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep('input')}>
              Back
            </Button>
            <Button
              onClick={handleImport}
              disabled={importMutation.isPending || !detectMutation.data.chainsDetected?.length}
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Importing...
                </>
              ) : (
                'Import Balances'
              )}
            </Button>
          </div>
        </div>
      )}

      {step === 'result' && importMutation.data && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6 text-center">
              <Wallet className="h-10 w-10 mx-auto text-green-500 mb-3" />
              <h3 className="text-lg font-semibold">Import Complete</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {importMutation.data.accounts?.length ?? 0} accounts and{' '}
                {importMutation.data.holdings?.length ?? 0} holdings imported
              </p>
              {importMutation.data.errors && importMutation.data.errors.length > 0 && (
                <div className="mt-3 text-left">
                  <p className="text-xs font-medium text-destructive mb-1">Errors:</p>
                  {importMutation.data.errors.map((err: { error: string }, i: number) => (
                    <p key={`err-${i}`} className="text-xs text-muted-foreground">
                      {err.error}
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => navigate(V2_ROUTES.holdings)}>
              View Holdings
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep('input');
                setAddress('');
                setDisplayName('');
              }}
            >
              Import Another
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
