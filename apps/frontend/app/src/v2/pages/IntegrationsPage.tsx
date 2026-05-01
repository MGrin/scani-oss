import { FaviconImg } from '@scani/ui/components/FaviconImg';
import { Badge } from '@scani/ui/ui/badge';
import { Card, CardContent } from '@scani/ui/ui/card';
import { FileUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFaviconUrl } from '@/lib/icons';
import type { RouterOutputs } from '@/lib/trpc';
import { trpc } from '@/lib/trpc';
import { ExchangeConnectDialog } from '../components/integrations/ExchangeConnectDialog';
import { V2_ROUTES } from '../lib/routes';

type Integration = RouterOutputs['integrations']['listAvailable'][number];

interface CategoryGroup {
  title: string;
  // Matches `institution_types.code` in the DB seed.
  typeCodes: readonly string[];
}

// Order = display order. Each group filters by one or more institution
// type codes (so "Crypto" can union crypto_exchange + crypto_wallet if
// we ever wire wallet providers here).
const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  { title: 'Crypto Exchanges', typeCodes: ['crypto_exchange'] },
  { title: 'Crypto Wallets', typeCodes: ['crypto_wallet'] },
  { title: 'Banks', typeCodes: ['bank', 'other'] },
  { title: 'Brokers', typeCodes: ['broker'] },
];

function IntegrationIcon({ name, website }: { name: string; website: string | null }) {
  const favicon = website ? getFaviconUrl(website) : null;
  return (
    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
      <FaviconImg
        src={favicon}
        name={name}
        className="h-5 w-5 object-contain"
        fallbackClassName="text-xs font-bold text-muted-foreground"
      />
    </div>
  );
}

interface IntegrationSectionProps {
  title: string;
  integrations: Integration[];
  onConnect: (integration: Integration) => void;
}

function IntegrationSection({ title, integrations, onConnect }: IntegrationSectionProps) {
  if (integrations.length === 0) return null;
  return (
    <section>
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {integrations.map((integration) => {
          const { institution } = integration;
          return (
            <Card
              key={integration.providerKey}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => onConnect(integration)}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <IntegrationIcon name={institution.name} website={institution.website} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{institution.name}</p>
                  {institution.description && (
                    <p className="text-xs text-muted-foreground line-clamp-1">
                      {institution.description}
                    </p>
                  )}
                </div>
                <Badge variant="outline" className="text-xs shrink-0">
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Badge>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

export function IntegrationsPage() {
  const navigate = useNavigate();
  const [connectIntegration, setConnectIntegration] = useState<Integration | null>(null);
  const { data: integrations = [], isLoading } = trpc.integrations.listAvailable.useQuery();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Integrations</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your exchanges, banks, and brokers for automatic balance syncing. You can add
          multiple connections per service.
        </p>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading available integrations…</p>
      )}

      {!isLoading &&
        CATEGORY_GROUPS.map((group) => {
          const groupIntegrations = integrations.filter((i) => {
            const code = i.institution.type?.code;
            return code !== undefined && group.typeCodes.includes(code);
          });
          return (
            <IntegrationSection
              key={group.title}
              title={group.title}
              integrations={groupIntegrations}
              onConnect={setConnectIntegration}
            />
          );
        })}

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

      {connectIntegration && (
        <ExchangeConnectDialog
          open={!!connectIntegration}
          onOpenChange={(open) => !open && setConnectIntegration(null)}
          integration={connectIntegration}
        />
      )}
    </div>
  );
}
