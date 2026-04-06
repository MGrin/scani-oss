import { FileUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getFaviconUrl } from '@/lib/icons';
import { ExchangeConnectDialog } from '../components/integrations/ExchangeConnectDialog';
import { V2_ROUTES } from '../lib/routes';

type CredentialType = 'apiKey' | 'passphrase' | 'wise' | 'ibkr';

interface ExchangeConfig {
  key: string;
  name: string;
  category: 'crypto_exchange' | 'crypto_wallet' | 'bank' | 'broker';
  credentialType: CredentialType;
  website: string;
}

const EXCHANGES: ExchangeConfig[] = [
  // Crypto Exchanges
  {
    key: 'binance',
    name: 'Binance',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.binance.com',
  },
  {
    key: 'kraken',
    name: 'Kraken',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.kraken.com',
  },
  {
    key: 'bybit',
    name: 'Bybit',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.bybit.com',
  },
  {
    key: 'okx',
    name: 'OKX',
    category: 'crypto_exchange',
    credentialType: 'passphrase',
    website: 'https://www.okx.com',
  },
  {
    key: 'coinbase',
    name: 'Coinbase',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.coinbase.com',
  },
  {
    key: 'kucoin',
    name: 'KuCoin',
    category: 'crypto_exchange',
    credentialType: 'passphrase',
    website: 'https://www.kucoin.com',
  },
  {
    key: 'gateio',
    name: 'Gate.io',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.gate.io',
  },
  {
    key: 'bitstamp',
    name: 'Bitstamp',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.bitstamp.net',
  },
  {
    key: 'gemini',
    name: 'Gemini',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.gemini.com',
  },
  {
    key: 'mexc',
    name: 'MEXC',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.mexc.com',
  },
  {
    key: 'bitget',
    name: 'Bitget',
    category: 'crypto_exchange',
    credentialType: 'passphrase',
    website: 'https://www.bitget.com',
  },
  {
    key: 'huobi',
    name: 'Huobi',
    category: 'crypto_exchange',
    credentialType: 'apiKey',
    website: 'https://www.huobi.com',
  },

  // Banks
  {
    key: 'wise',
    name: 'Wise',
    category: 'bank',
    credentialType: 'wise',
    website: 'https://wise.com',
  },

  // Brokers
  {
    key: 'ibkr',
    name: 'Interactive Brokers',
    category: 'broker',
    credentialType: 'ibkr',
    website: 'https://www.interactivebrokers.com',
  },
];

function ExchangeIcon({ name, website }: { name: string; website: string }) {
  const favicon = getFaviconUrl(website);
  return (
    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
      {favicon ? (
        <img
          src={favicon}
          alt={`${name} logo`}
          className="h-5 w-5 object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <span className="text-xs font-bold text-muted-foreground">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}

function credentialLabel(type: CredentialType): string {
  switch (type) {
    case 'apiKey':
      return 'API Key';
    case 'passphrase':
      return 'API Key + Passphrase';
    case 'wise':
      return 'API Token';
    case 'ibkr':
      return 'Flex Query';
  }
}

interface ExchangeSectionProps {
  title: string;
  exchanges: ExchangeConfig[];
  onConnect: (exchange: ExchangeConfig) => void;
}

function ExchangeSection({ title, exchanges, onConnect }: ExchangeSectionProps) {
  if (exchanges.length === 0) return null;
  return (
    <section>
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {exchanges.map((exchange) => (
          <Card
            key={exchange.key}
            className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => onConnect(exchange)}
          >
            <CardContent className="flex items-center gap-3 p-4">
              <ExchangeIcon name={exchange.name} website={exchange.website} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm">{exchange.name}</p>
                <p className="text-xs text-muted-foreground">
                  {credentialLabel(exchange.credentialType)}
                </p>
              </div>
              <Badge variant="outline" className="text-xs shrink-0">
                <Plus className="h-3 w-3 mr-1" />
                Add
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function IntegrationsPage() {
  const navigate = useNavigate();
  const [connectExchange, setConnectExchange] = useState<ExchangeConfig | null>(null);

  const cryptoExchanges = EXCHANGES.filter((e) => e.category === 'crypto_exchange');
  const cryptoWallets = EXCHANGES.filter((e) => e.category === 'crypto_wallet');
  const banks = EXCHANGES.filter((e) => e.category === 'bank');
  const brokers = EXCHANGES.filter((e) => e.category === 'broker');

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Integrations</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your exchanges, banks, and brokers for automatic balance syncing. You can add
          multiple connections per service.
        </p>
      </div>

      <ExchangeSection
        title="Crypto Exchanges"
        exchanges={cryptoExchanges}
        onConnect={setConnectExchange}
      />

      <ExchangeSection
        title="Crypto Wallets"
        exchanges={cryptoWallets}
        onConnect={setConnectExchange}
      />

      <ExchangeSection title="Banks" exchanges={banks} onConnect={setConnectExchange} />

      <ExchangeSection title="Brokers" exchanges={brokers} onConnect={setConnectExchange} />

      {/* File Import */}
      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          File Import
        </h3>
        <Card
          className="cursor-pointer hover:border-primary/50 transition-colors max-w-md"
          onClick={() => navigate(V2_ROUTES.fileImport)}
        >
          <CardContent className="flex items-center gap-3 p-4">
            <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <FileUp className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-sm">CSV / OFX / Screenshot Import</p>
              <p className="text-xs text-muted-foreground">
                Import bank statements or screenshots from any institution
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Connect Dialog */}
      {connectExchange && (
        <ExchangeConnectDialog
          open={!!connectExchange}
          onOpenChange={(open) => !open && setConnectExchange(null)}
          exchange={connectExchange}
        />
      )}
    </div>
  );
}
