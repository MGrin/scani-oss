import { ArrowLeft, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { showError } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { useJobStatus } from '../hooks/useJobStatus';
import { V2_ROUTES } from '../lib/routes';

/**
 * Crypto wallet import entry.
 *
 * The old two-step UX (sync detect → review detected chains → import)
 * forced the user to wait on the detection page, and leaving mid-detect
 * lost the work. The worker's `wallet-import` job already runs the full
 * chain-detection + balance-fetch pipeline, so we skip the separate
 * detect step entirely. Single form → enqueue → job page.
 */
type Step = 'input' | 'submitting' | 'importing';

export function WalletImportPage() {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const navigate = useNavigate();

  const importMutation = trpc.wallet.importAddress.useMutation({
    onSuccess: ({ jobId }) => {
      setActiveJobId(jobId);
      setStep('importing');
    },
    onError: (err) => {
      showError(err, 'Importing wallet');
      setStep('input');
    },
  });

  const jobStatus = useJobStatus(activeJobId);
  // Both terminal outcomes land on the job detail page: completed shows
  // the grouped-by-chain review (WalletImportResult), failed shows the
  // worker error. Consistent with exchange/IBKR flows.
  useEffect(() => {
    if (step !== 'importing' || !activeJobId) return;
    if (jobStatus.state === 'completed' || jobStatus.state === 'failed') {
      navigate(V2_ROUTES.jobDetail(activeJobId));
    }
  }, [step, activeJobId, jobStatus.state, navigate]);

  const handleImport = () => {
    if (!address.trim()) return;
    setStep('submitting');
    importMutation.mutate({
      address: address.trim(),
      displayName: displayName.trim() || undefined,
      chain: 'auto',
      requestId: crypto.randomUUID(),
    });
  };

  const isBusy = step === 'submitting' || step === 'importing';

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
          Enter a wallet address. We'll auto-detect every supported chain, fetch balances, and drop
          you on the review screen — you can navigate away while it runs.
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
              placeholder="0x… or bc1… or any supported blockchain address"
              className="font-mono text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleImport();
              }}
              disabled={isBusy}
            />
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (optional)"
              disabled={isBusy}
            />
            <Button onClick={handleImport} disabled={!address.trim() || isBusy} className="w-full">
              Import wallet
            </Button>
          </CardContent>
        </Card>
      )}

      {(step === 'submitting' || step === 'importing') && (
        <Card>
          <CardContent className="p-10 space-y-4">
            <div className="space-y-1 text-center">
              <p className="font-medium">
                {step === 'submitting'
                  ? 'Starting import…'
                  : 'Detecting chains & fetching balances…'}
              </p>
              <p className="text-xs text-muted-foreground">
                This usually takes 10–30 seconds. You'll land on the review page when it's done, or
                see the error if anything failed.
              </p>
            </div>
            {step === 'submitting' ? (
              <div className="flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : (
              // Indeterminate bouncing bar — same pattern as ExchangeConnectDialog + JobHeader.
              <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
                <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-loading-bar" />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
