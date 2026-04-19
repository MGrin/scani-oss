import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { trpcVanilla } from '@/lib/trpc-vanilla';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { V2_ROUTES } from '@/v2/lib/routes';

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

interface ExchangeHelp {
  steps: string[];
  docsUrl?: string;
  mobileNote?: string; // Shown when user is on mobile
}

const API_KEY_HELP: Record<string, ExchangeHelp> = {
  binance: {
    steps: [
      'Log in to Binance → Profile icon → API Management',
      'Click "Create API" and enter a label',
      'Complete 2FA verification (email + authenticator)',
      'Keep only "Enable Reading" checked (default) — disable all trading/withdrawal permissions',
    ],
    docsUrl: 'https://www.binance.com/en/support/faq/detail/360002502072',
    mobileNote: 'You can create API keys in the Binance app: Home → More → API Management',
  },
  kraken: {
    steps: [
      'Log in to Kraken Pro → Profile icon → Settings → API tab',
      'Click "Create API key" and enter a name',
      'Enable only "Query Funds" and "Query Orders & Trades"',
      'Do NOT enable "Modify Orders" or withdrawal permissions',
    ],
    docsUrl: 'https://support.kraken.com/articles/360000919966-how-to-create-an-api-key',
    mobileNote: 'Use a desktop browser to access Kraken Pro settings.',
  },
  bybit: {
    steps: [
      'Log in to Bybit → Profile icon → API',
      'Click "Create New Key" → "System-generated API Key"',
      'Set API Key Permissions to "Read-Only"',
      'Complete Google Authenticator verification',
      'Copy API Key and Secret (shown only once)',
    ],
    docsUrl: 'https://www.bybit.com/en/help-center/article/How-to-create-your-API-key',
    mobileNote: 'Use a desktop browser to create API keys on Bybit.',
  },
  okx: {
    steps: [
      'Log in to OKX on desktop → User icon → API',
      'Click "Create V5 API Key"',
      'Enter a key name and create a passphrase (save it — cannot be recovered)',
      'Set permissions to "Read" only',
      'Copy API Key, Secret Key, and Passphrase',
    ],
    docsUrl: 'https://www.okx.com/docs-v5/en/',
    mobileNote: 'OKX requires a desktop/PC to create API keys — not available on mobile.',
  },
  coinbase: {
    steps: [
      'Log in to Coinbase → Grid icon (top right) → Developer Platform',
      'Click "API Keys" → "Create API Key"',
      'Set permission to "View" only — do NOT enable Trade or Transfer',
      'Set signature algorithm to ECDSA',
      'Click "Create & Download" — secret downloads as a JSON file (shown only once)',
    ],
    docsUrl: 'https://help.coinbase.com/en/exchange/managing-my-account/how-to-create-an-api-key',
    mobileNote: 'Use a desktop browser to access the Coinbase Developer Platform.',
  },
  kucoin: {
    steps: [
      'Log in to KuCoin → Avatar → API Management',
      'Click "Create API" → "API Trading"',
      'Enter API name and create a passphrase (different from your passwords — save it)',
      'Enable "General" permission only — do NOT enable Trade or Transfer',
      'Complete verification (trading password + email + Google Authenticator)',
    ],
    docsUrl:
      'https://www.kucoin.com/docs/basic-info/connection-method/authentication/generating-an-api-key',
    mobileNote: 'Use a desktop browser to create API keys on KuCoin.',
  },
  gateio: {
    steps: [
      'Log in to Gate.io → Profile icon → API Management',
      'Click "Create API Key" and enter a name',
      'Under API Permissions, select "Enable Reading" only',
      'Do NOT enable Trading or Withdrawals',
      'Copy API Key and Secret Key (secret shown only once)',
    ],
    docsUrl: 'https://www.gate.com/help/guide/common/17521/how-to-utilize-api',
    mobileNote: 'Use a desktop browser to create API keys on Gate.io.',
  },
  bitstamp: {
    steps: [
      'Log in to Bitstamp → Profile icon → Settings → API Access',
      'Click "New API Key"',
      'Enable only "Account Balance" and "User Transactions" permissions',
      'Do NOT enable Orders, Transfers, or Withdrawals',
      'Check your email — click the activation link to finalize the key',
    ],
    docsUrl: 'https://www.bitstamp.net/api/',
    mobileNote: 'Use a desktop browser to create API keys on Bitstamp.',
  },
  gemini: {
    steps: [
      'Log in to Gemini → Menu → Account → API',
      'Click "Create a new API Key" and enter your 2FA code',
      'Set the role to "Auditor" for read-only access',
      'Choose IP restriction: "Unrestricted" or "Trusted IPs Only"',
      'Copy API Key and Secret',
    ],
    docsUrl: 'https://support.gemini.com/hc/en-us/articles/360031080191-How-do-I-create-an-API-key',
    mobileNote: 'Possible on mobile web, but desktop browser is recommended.',
  },
  mexc: {
    steps: [
      'Log in to MEXC → Profile icon → API Management',
      'Click "Create New API Key" and enter a label',
      'Enable only read/view permissions under Spot',
      'Do NOT enable Withdraw or Transfer',
      'Note: keys without IP binding expire after 90 days',
    ],
    docsUrl: 'https://www.mexc.com/support/articles/360055933652',
    mobileNote: 'Use a desktop browser to create API keys on MEXC.',
  },
  bitget: {
    steps: [
      'Log in to Bitget → Account icon → API Keys',
      'Click "Create API Key" → "System-generated"',
      'Enter a name and create a passphrase (save it — cannot be recovered if lost)',
      'Set permissions to "Read-Only"',
      'Copy API Key, Secret Key, and Passphrase',
    ],
    docsUrl: 'https://www.bitget.com/support/articles/360038968251-API-Creation-Guide',
    mobileNote: 'Use a desktop browser to create API keys on Bitget.',
  },
  huobi: {
    steps: [
      'Log in to HTX (Huobi) → Account icon → API Management',
      'Click "Create API Key" and enter a label',
      'Check "Read" permission only — do NOT enable Trade or Withdraw',
      'Complete SMS + Email + Google Authenticator verification',
      'Copy API Key and Secret Key (secret shown only once)',
    ],
    docsUrl: 'https://www.htx.com/support/360000203002',
    mobileNote: 'Use a desktop browser to create API keys on HTX.',
  },
  wise: {
    steps: [
      'Log in to your Wise Business account at wise.com',
      'Go to Your Account → Integrations and Tools → API tokens',
      'Click "Add new token" and complete 2-step verification',
      'Copy and securely store the token (shown only once)',
    ],
    docsUrl: 'https://docs.wise.com/guides/developer/auth-and-security/personal-api-token',
    mobileNote: 'Use a desktop browser. Requires a Wise Business account (not personal).',
  },
  ibkr: {
    steps: [
      'Log in to IBKR Client Portal → Performance & Reports → Flex Queries',
      'Under "Activity Flex Queries", click "+" to create a new query',
      'In the query editor, add these sections: "Open Positions" (check all fields) and "Cash Report" (enable "Ending Cash" or "Ending Settled Cash")',
      'Save the query and note the Query ID (shown next to the query name)',
      'Scroll down to "Flex Web Service", enable it, and click "Generate New Token"',
      'Copy the token (shown only once) and paste it below along with the Query ID',
    ],
    docsUrl: 'https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/',
    mobileNote: 'Use a desktop browser to access IBKR Client Portal.',
  },
};

function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
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

  const utils = trpc.useUtils();
  const navigate = useNavigate();

  const help = API_KEY_HELP[exchange.key];
  const isMobile = isMobileDevice();
  const isLoading = status === 'loading';

  const handleSubmit = async () => {
    setStatus('loading');
    setErrorMsg('');

    try {
      // We need to dispatch to one of ~13 different routers
      // (trpc.integrations.kraken, .binance, .coinbase, …) based on
      // the `exchange.key` prop. The React tRPC client exposes those
      // as `.useMutation()` hooks, which can't be called conditionally
      // or inside an event handler, so we can't pick the right one
      // at submit time. The vanilla proxy client (from
      // `trpc-vanilla.ts`) exposes `.mutate()` as a real method and
      // supports dynamic property access — exactly what we need here.
      //
      // Why the switch: the previous implementation cast the React
      // client to `any` and did
      // `trpc.integrations[key].validateKeys.mutate(input)`. That
      // traverses the React client's proxy, which returns hook
      // constructors at the leaves, not callable `.mutate()` methods.
      // `.mutate` was therefore a non-callable proxy node and threw
      // on invocation — surfaced as the minified error
      // `t[s] is not a function` that reproduced on every exchange
      // (Kraken, Binance, Coinbase, etc.) regardless of credentials.

      const requestId = crypto.randomUUID();
      let input: Record<string, string>;
      switch (exchange.credentialType) {
        case 'apiKey':
          input = { apiKey, apiSecret, requestId };
          break;
        case 'passphrase':
          input = { apiKey, apiSecret, passphrase, requestId };
          break;
        case 'wise':
          input = { apiToken: token, requestId };
          break;
        case 'ibkr':
          input = { token, queryId, requestId };
          break;
        default:
          input = { apiKey, apiSecret, requestId };
      }

      // biome-ignore lint/suspicious/noExplicitAny: dynamic router path
      const integrationsClient = (trpcVanilla as any).integrations;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic router path
      const router: any = integrationsClient?.[exchange.key];
      if (!router) {
        // Can only happen if the `exchange.key` prop is something not
        // in the backend router map — a programmer error, not a user
        // error. The backend router itself can't validate this
        // without a roundtrip.
        throw new Error(`No integration client for "${exchange.key}"`);
      }
      const result = await router.validateKeys.mutate(input);
      setStatus('success');
      // Invalidate everything — connecting an exchange creates accounts
      // and holdings, which roll up into institutions, dashboard totals,
      // vaults, and the asset-allocation chart.
      await invalidatePortfolioQueries(utils);

      // Navigate to holdings filtered by institution after a brief delay
      // so the user sees the success state before navigating away.
      const institutionId = result?.institutionId;
      if (institutionId) {
        setTimeout(() => {
          resetForm();
          onOpenChange(false);
          navigate(`${V2_ROUTES.holdings}?institution=${institutionId}`);
        }, 800);
      }
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
        if (isLoading) return;
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

        {/* Mobile warning */}
        {isMobile && help?.mobileNote && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3">
            <p className="text-xs font-medium text-yellow-700 dark:text-yellow-400">
              {help.mobileNote}
            </p>
          </div>
        )}

        {/* Help section */}
        {help && (
          <div className="rounded-md bg-muted/50 p-3 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              How to get your{' '}
              {exchange.credentialType === 'wise'
                ? 'API token'
                : exchange.credentialType === 'ibkr'
                  ? 'Flex Query credentials'
                  : 'API keys'}
              :
            </p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              {help.steps.map((step) => (
                <li key={step}>{step}</li>
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
        )}

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
                  disabled={isLoading}
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
                  disabled={isLoading}
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
                disabled={isLoading}
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
                disabled={isLoading}
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
                  disabled={isLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ibkr-query">Flex Query ID</Label>
                <Input
                  id="ibkr-query"
                  value={queryId}
                  onChange={(e) => setQueryId(e.target.value)}
                  placeholder="Enter query ID"
                  disabled={isLoading}
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
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid() || isLoading || status === 'success'}>
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
