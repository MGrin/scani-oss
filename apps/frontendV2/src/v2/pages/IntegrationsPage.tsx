import { FileUp, Link2, Plug } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ExchangeConnectDialog } from '../components/integrations/ExchangeConnectDialog';
import { V2_ROUTES } from '../lib/routes';

type CredentialType = 'apiKey' | 'passphrase' | 'wise' | 'ibkr';

interface ExchangeConfig {
  key: string;
  name: string;
  category: 'crypto' | 'bank' | 'broker';
  credentialType: CredentialType;
}

const EXCHANGES: ExchangeConfig[] = [
  { key: 'binance', name: 'Binance', category: 'crypto', credentialType: 'apiKey' },
  { key: 'kraken', name: 'Kraken', category: 'crypto', credentialType: 'apiKey' },
  { key: 'bybit', name: 'Bybit', category: 'crypto', credentialType: 'apiKey' },
  { key: 'okx', name: 'OKX', category: 'crypto', credentialType: 'passphrase' },
  { key: 'coinbase', name: 'Coinbase', category: 'crypto', credentialType: 'apiKey' },
  { key: 'kucoin', name: 'KuCoin', category: 'crypto', credentialType: 'passphrase' },
  { key: 'gateio', name: 'Gate.io', category: 'crypto', credentialType: 'apiKey' },
  { key: 'bitstamp', name: 'Bitstamp', category: 'crypto', credentialType: 'apiKey' },
  { key: 'gemini', name: 'Gemini', category: 'crypto', credentialType: 'apiKey' },
  { key: 'mexc', name: 'MEXC', category: 'crypto', credentialType: 'apiKey' },
  { key: 'bitget', name: 'Bitget', category: 'crypto', credentialType: 'passphrase' },
  { key: 'huobi', name: 'Huobi', category: 'crypto', credentialType: 'apiKey' },
  { key: 'wise', name: 'Wise', category: 'bank', credentialType: 'wise' },
  { key: 'ibkr', name: 'Interactive Brokers', category: 'broker', credentialType: 'ibkr' },
];

export function IntegrationsPage() {
  const navigate = useNavigate();
  const [connectExchange, setConnectExchange] = useState<ExchangeConfig | null>(null);

  const cryptoExchanges = EXCHANGES.filter((e) => e.category === 'crypto');
  const banksAndBrokers = EXCHANGES.filter((e) => e.category !== 'crypto');

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Integrations</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your exchanges, banks, and brokers for automatic balance syncing
        </p>
      </div>

      {/* Crypto Exchanges */}
      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Crypto Exchanges
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {cryptoExchanges.map((exchange) => (
            <Card
              key={exchange.key}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => setConnectExchange(exchange)}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Link2 className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{exchange.name}</p>
                  <p className="text-xs text-muted-foreground">API Key</p>
                </div>
                <Badge variant="outline" className="text-xs shrink-0">
                  Connect
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Banks & Brokers */}
      <section>
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Banks &amp; Brokers
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {banksAndBrokers.map((exchange) => (
            <Card
              key={exchange.key}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => setConnectExchange(exchange)}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Plug className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{exchange.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {exchange.credentialType === 'wise'
                      ? 'API Token'
                      : exchange.credentialType === 'ibkr'
                        ? 'Flex Query'
                        : 'API Key'}
                  </p>
                </div>
                <Badge variant="outline" className="text-xs shrink-0">
                  Connect
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

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
              <p className="font-medium text-sm">CSV / OFX Import</p>
              <p className="text-xs text-muted-foreground">
                Import bank statements from Revolut, Tinkoff, Sberbank, and more
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
