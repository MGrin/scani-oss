import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { showError } from '@scani/ui/ui/use-toast';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

/**
 * Crypto wallet import entry.
 *
 * Form-only page. After enqueue we hand off to /jobs/:jobId — the
 * unified JobDetailPage renders progress + WalletImportResult on
 * completion. Same pattern as FileImportPage / ExchangeConnectDialog /
 * ManualEntryPage.
 */
export function WalletImportPage() {
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const importMutation = trpc.wallet.importAddress.useMutation({
    onSuccess: ({ jobId }) => {
      navigate(V2_ROUTES.jobDetail(jobId));
    },
    onError: (err) => {
      showError(err, 'Importing wallet');
      setSubmitting(false);
    },
  });

  const handleImport = () => {
    if (!address.trim()) return;
    setSubmitting(true);
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
          Enter a wallet address. We'll auto-detect every supported chain, fetch balances, and drop
          you on the job page where you can review what was imported.
        </p>
      </div>

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
            disabled={submitting}
          />
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name (optional)"
            disabled={submitting}
          />
          <Button
            onClick={handleImport}
            disabled={!address.trim() || submitting}
            className="w-full"
          >
            {submitting ? 'Starting import…' : 'Import wallet'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
