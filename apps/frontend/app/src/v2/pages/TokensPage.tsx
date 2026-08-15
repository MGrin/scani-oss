import { formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent } from '@scani/ui/ui/card';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { CreateCustomTokenDialog } from '../components/tokens/CreateCustomTokenDialog';
import { EditCustomTokenPriceDialog } from '../components/tokens/EditCustomTokenPriceDialog';
import { HiddenHoldingsSection } from '../components/tokens/HiddenHoldingsSection';
import { formatMoneyPlain } from '../lib/format';

const SKELETON_KEYS = ['a', 'b', 'c', 'd'];

function formatPrice(value: string | null, currency: string | null): string {
  if (value == null) return '—';
  if (!Number.isFinite(Number(value))) return value;
  const formatted = formatMoneyPlain(value);
  return currency ? `${formatted} ${currency}` : formatted;
}

function CustomTokensSection() {
  const { data: tokens, isLoading } = trpc.tokens.listCustom.useQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<{
    tokenId: string;
    tokenSymbol: string;
    currentPrice: string | null;
    currentBaseCurrency: string | null;
  } | null>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Custom tokens</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Manually-priced assets (private company shares, custom holdings). Shared across all
            users; any user can update the price.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New custom token
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {SKELETON_KEYS.map((k) => (
            <Skeleton key={`tokens-skel-${k}`} className="h-16" />
          ))}
        </div>
      ) : tokens && tokens.length > 0 ? (
        <div className="space-y-2">
          {tokens.map((t) => (
            <Card key={t.id} className="hover:border-primary/50 transition-colors">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{t.symbol}</span>
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {t.typeCode?.replace('-', ' ') ?? '—'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{t.name}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-mono text-sm">
                    {formatPrice(t.latestPrice, t.latestPriceBaseCurrency)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatRelative(t.latestPriceAt)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() =>
                    setEditing({
                      tokenId: t.id,
                      tokenSymbol: t.symbol,
                      currentPrice: t.latestPrice,
                      currentBaseCurrency: t.latestPriceBaseCurrency,
                    })
                  }
                  title="Edit price"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No custom tokens yet. Create one for assets no pricing provider tracks.
          </CardContent>
        </Card>
      )}

      <CreateCustomTokenDialog open={createOpen} onOpenChange={setCreateOpen} />

      {editing && (
        <EditCustomTokenPriceDialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          tokenId={editing.tokenId}
          tokenSymbol={editing.tokenSymbol}
          currentPrice={editing.currentPrice}
          currentBaseCurrency={editing.currentBaseCurrency}
        />
      )}
    </div>
  );
}

export function TokensPage() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Tokens</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage manually-priced custom tokens and review holdings hidden from your dashboard.
        </p>
      </div>

      <CustomTokensSection />
      <HiddenHoldingsSection />
    </div>
  );
}
