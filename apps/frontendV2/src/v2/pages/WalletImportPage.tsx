import { ArrowLeft, Check, Loader2, Search, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

type Step = 'input' | 'detecting' | 'detected' | 'importing' | 'result';

export function WalletImportPage() {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [step, setStep] = useState<Step>('input');
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const detectMutation = trpc.wallet.detectChains.useMutation({
    onSuccess: () => setStep('detected'),
    onError: (err) => {
      showError(err, 'Detecting chains');
      setStep('input');
    },
  });

  const importMutation = trpc.wallet.importAddress.useMutation({
    onSuccess: (result) => {
      setStep('result');
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();
      showSuccess(
        `Imported ${result.holdings?.length ?? 0} holdings across ${result.accounts?.length ?? 0} accounts`
      );
    },
    onError: (err) => {
      showError(err, 'Importing wallet');
      setStep('detected');
    },
  });

  const handleDetect = () => {
    if (!address.trim()) return;
    setStep('detecting');
    detectMutation.mutate({ address: address.trim() });
  };

  const handleImport = () => {
    setStep('importing');
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

      {/* Step 1: Input */}
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
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleDetect();
              }}
            />
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (optional)"
            />
            <Button onClick={handleDetect} disabled={!address.trim()}>
              <Search className="h-4 w-4 mr-2" />
              Detect Chains
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Detecting */}
      {step === 'detecting' && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="font-medium">Detecting blockchain chains...</p>
            <p className="text-xs text-muted-foreground mt-1">
              Scanning supported networks for activity at this address
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Detected */}
      {step === 'detected' && detectMutation.data && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detected Chains</CardTitle>
            </CardHeader>
            <CardContent>
              {detectMutation.data.chainsDetected?.length > 0 ? (
                <div className="space-y-2">
                  {detectMutation.data.chainsDetected.map((chain) => (
                    <div
                      key={String(chain.chainId)}
                      className="flex items-center gap-2 p-2 rounded-md border border-border"
                    >
                      <Check className="h-4 w-4 text-green-500 shrink-0" />
                      <span className="font-medium text-sm">{chain.name}</span>
                      <Badge variant="secondary" className="text-[10px] ml-auto">
                        {chain.type}
                      </Badge>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground mt-2">
                    {detectMutation.data.chainsDetected.length} chain(s) found. Click "Import" to
                    fetch all balances.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No supported chains detected for this address.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button onClick={handleImport} disabled={!detectMutation.data.chainsDetected?.length}>
              Import Balances
            </Button>
            <Button variant="outline" onClick={() => setStep('input')}>
              Change Address
            </Button>
          </div>
        </div>
      )}

      {/* Step 4: Importing */}
      {step === 'importing' && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="font-medium">Importing wallet balances...</p>
            <p className="text-xs text-muted-foreground mt-1">
              Fetching balances from all detected chains. This may take a moment.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step 5: Result */}
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
            <Button onClick={() => navigate(V2_ROUTES.holdings)}>View Holdings</Button>
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
