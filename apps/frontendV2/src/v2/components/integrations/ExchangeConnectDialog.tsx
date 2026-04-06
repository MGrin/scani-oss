import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  website?: string;
}

interface ExchangeConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exchange: ExchangeConfig;
}

const API_KEY_HELP: Record<string, { steps: string[]; docsUrl?: string }> = {
  binance: {
    steps: [
      'Go to Binance → Account → API Management',
      'Create a new API key with "Read Only" permissions',
      'Enable "Enable Reading" and disable all other permissions',
      'Whitelist your IP if required',
    ],
    docsUrl:
      'https://www.binance.com/en/support/faq/how-to-create-api-keys-on-binance-360002502072',
  },
  kraken: {
    steps: [
      'Go to Kraken → Security → API',
      'Create a new key with "Query Funds" permission only',
      'Do not enable trading or withdrawal permissions',
    ],
    docsUrl: 'https://support.kraken.com/hc/en-us/articles/360000919966-How-to-create-an-API-key',
  },
  bybit: {
    steps: [
      'Go to Bybit → Account & Security → API',
      'Create a new API key with "Read-Only" permissions',
    ],
  },
  okx: {
    steps: [
      'Go to OKX → Settings → API',
      'Create a new API key with "Read Only" permissions',
      'You will need the API Key, Secret, and Passphrase',
    ],
  },
  coinbase: {
    steps: [
      'Go to Coinbase → Settings → API',
      'Create a new API key with "View" permissions for all accounts',
    ],
  },
  kucoin: {
    steps: [
      'Go to KuCoin → API Management',
      'Create a new API key with read-only permissions',
      'You will need the API Key, Secret, and Passphrase',
    ],
  },
  wise: {
    steps: [
      'Go to Wise → Settings → API tokens',
      'Create a "Read only" token',
      'Copy the full API token string',
    ],
    docsUrl: 'https://wise.com/help/articles/2958149',
  },
  ibkr: {
    steps: [
      'Log in to IBKR Client Portal or Account Management',
      'Go to Settings → Flex Web Service',
      'Create a Flex Query for your account positions',
      'Copy the Token and Query ID',
    ],
    docsUrl: 'https://www.interactivebrokers.com/en/software/am3/am/settings/flextradereports.htm',
  },
};

function getDefaultHelp(credentialType: string): { steps: string[]; docsUrl?: string } {
  switch (credentialType) {
    case 'passphrase':
      return {
        steps: [
          "Navigate to your exchange's API settings page",
          'Create a new API key with read-only permissions',
          'Copy the API Key, Secret, and Passphrase',
        ],
      };
    case 'wise':
      return { steps: ['Create a read-only API token in your account settings'] };
    case 'ibkr':
      return { steps: ['Set up Flex Web Service in your IBKR account'] };
    default:
      return {
        steps: [
          "Navigate to your exchange's API settings page",
          'Create a new API key with read-only permissions',
          'Copy the API Key and Secret',
        ],
      };
  }
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

  const help = API_KEY_HELP[exchange.key] || getDefaultHelp(exchange.credentialType);

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
          <DialogDescription>
            Enter your API credentials. Only read-only permissions are needed.
          </DialogDescription>
        </DialogHeader>

        {/* Help section */}
        <div className="rounded-md bg-muted/50 p-3 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">How to get your API keys:</p>
          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            {help.steps.map((step, i) => (
              <li key={`step-${i}`}>{step}</li>
            ))}
          </ol>
          {help.docsUrl && (
            <a
              href={help.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
            >
              View documentation
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

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
