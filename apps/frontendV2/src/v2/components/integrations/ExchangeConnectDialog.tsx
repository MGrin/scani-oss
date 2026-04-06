import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

interface ExchangeConfig {
  key: string;
  name: string;
  credentialType: 'apiKey' | 'passphrase' | 'wise' | 'ibkr';
}

interface ExchangeConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exchange: ExchangeConfig;
}

export function ExchangeConnectDialog({
  open,
  onOpenChange,
  exchange,
}: ExchangeConnectDialogProps) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [token, setToken] = useState('');
  const [queryId, setQueryId] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // biome-ignore lint/suspicious/noExplicitAny: Dynamic tRPC router access
  const integrations = trpc.integrations as any;

  const handleSubmit = async () => {
    setStatus('loading');
    setErrorMsg('');

    try {
      const router = integrations[exchange.key];
      if (!router?.validateKeys?.mutate) {
        setErrorMsg('Integration not available');
        setStatus('error');
        return;
      }

      let input: Record<string, string>;
      switch (exchange.credentialType) {
        case 'apiKey':
          input = { apiKey, apiSecret };
          break;
        case 'passphrase':
          input = { apiKey, apiSecret, passphrase };
          break;
        case 'wise':
          input = { apiToken: token };
          break;
        case 'ibkr':
          input = { token, queryId };
          break;
        default:
          input = { apiKey, apiSecret };
      }

      await router.validateKeys.mutate(input);
      setStatus('success');
      setTimeout(() => {
        onOpenChange(false);
        resetForm();
      }, 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed');
      setStatus('error');
    }
  };

  const resetForm = () => {
    setApiKey('');
    setApiSecret('');
    setPassphrase('');
    setToken('');
    setQueryId('');
    setStatus('idle');
    setErrorMsg('');
  };

  const isValid = () => {
    switch (exchange.credentialType) {
      case 'apiKey':
        return apiKey.length > 0 && apiSecret.length > 0;
      case 'passphrase':
        return apiKey.length > 0 && apiSecret.length > 0 && passphrase.length > 0;
      case 'wise':
        return token.length > 0;
      case 'ibkr':
        return token.length > 0 && queryId.length > 0;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {exchange.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {(exchange.credentialType === 'apiKey' || exchange.credentialType === 'passphrase') && (
            <>
              <div className="space-y-2">
                <Label htmlFor="api-key">API Key</Label>
                <Input
                  id="api-key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter API key"
                  type="password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="api-secret">API Secret</Label>
                <Input
                  id="api-secret"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  placeholder="Enter API secret"
                  type="password"
                />
              </div>
            </>
          )}

          {exchange.credentialType === 'passphrase' && (
            <div className="space-y-2">
              <Label htmlFor="passphrase">Passphrase</Label>
              <Input
                id="passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Enter passphrase"
                type="password"
              />
            </div>
          )}

          {exchange.credentialType === 'wise' && (
            <div className="space-y-2">
              <Label htmlFor="wise-token">API Token</Label>
              <Input
                id="wise-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter Wise API token"
                type="password"
              />
            </div>
          )}

          {exchange.credentialType === 'ibkr' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="ibkr-token">Flex Web Service Token</Label>
                <Input
                  id="ibkr-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Enter token"
                  type="password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ibkr-query">Flex Query ID</Label>
                <Input
                  id="ibkr-query"
                  value={queryId}
                  onChange={(e) => setQueryId(e.target.value)}
                  placeholder="Enter query ID"
                />
              </div>
            </>
          )}

          {status === 'success' && (
            <p className="text-sm text-green-600 font-medium">
              Connected successfully! Balances will sync automatically.
            </p>
          )}

          {status === 'error' && <p className="text-sm text-destructive">{errorMsg}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid() || status === 'loading' || status === 'success'}
          >
            {status === 'loading'
              ? 'Connecting...'
              : status === 'success'
                ? 'Connected'
                : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
