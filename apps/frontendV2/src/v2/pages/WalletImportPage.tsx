import { ArrowLeft, Check, Loader2, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { JobProgressModal } from '../components/JobProgressModal';
import { V2_ROUTES } from '../lib/routes';

type Step = 'input' | 'detecting' | 'detected';

export function WalletImportPage() {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const detectMutation = trpc.wallet.detectChains.useMutation({
    onSuccess: (data) => {
      if (data.ensName && !displayName.trim()) {
        setDisplayName(data.ensName);
      }
      setStep('detected');
    },
    onError: (err) => {
      showError(err, 'Detecting chains');
      setStep('input');
    },
  });

  const importMutation = trpc.wallet.importAddress.useMutation({
    onSuccess: ({ jobId }) => {
      setImportJobId(jobId);
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
    importMutation.mutate({
      address: address.trim(),
      displayName: displayName.trim() || undefined,
      chain: 'auto',
      requestId: crypto.randomUUID(),
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

      {step === 'detecting' && (
        <Card>
          <CardContent className="p-12 flex flex-col items-center justify-center text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="font-medium">Detecting blockchain chains...</p>
          </CardContent>
        </Card>
      )}

      {step === 'detected' && detectMutation.data && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detected Chains</CardTitle>
            </CardHeader>
            <CardContent>
              {detectMutation.data.chainsDetected?.length > 0 ? (
                <div className="space-y-2">
                  {detectMutation.data.ensName && (
                    <p className="text-sm text-muted-foreground">
                      ENS name resolved:{' '}
                      <span className="font-medium text-foreground">
                        {detectMutation.data.ensName}
                      </span>
                    </p>
                  )}
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

      <JobProgressModal
        jobId={importJobId}
        title="Importing wallet"
        description="Detecting chains, fetching balances, and warming prices. This can take up to a minute."
        onCompleted={async (result) => {
          const summary = result as {
            accountsCreated?: number;
            holdingsCreated?: number;
            chainsDetected?: number;
          } | null;
          await utils.invalidate();
          const accounts = summary?.accountsCreated ?? 0;
          const holdings = summary?.holdingsCreated ?? 0;
          showSuccess(`Imported ${holdings} holdings across ${accounts} accounts`);
          setImportJobId(null);
          navigate(V2_ROUTES.holdings);
        }}
        onFailed={(error) => {
          showError(new Error(error), 'Wallet import');
          setImportJobId(null);
        }}
        onDismiss={() => setImportJobId(null)}
      />
    </div>
  );
}
