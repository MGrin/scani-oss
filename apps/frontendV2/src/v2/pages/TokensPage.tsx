import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { CreateCustomTokenDialog } from '../components/tokens/CreateCustomTokenDialog';
import { EditCustomTokenPriceDialog } from '../components/tokens/EditCustomTokenPriceDialog';

const SKELETON_KEYS = ['a', 'b', 'c', 'd'];

function formatPrice(value: string | null, currency: string | null): string {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const formatted = n.toLocaleString('en-US', { maximumFractionDigits: 8 });
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatRelative(date: string | Date | null): string {
  if (!date) return '—';
  const t = typeof date === 'string' ? new Date(date).getTime() : date.getTime();
  const diffMs = Date.now() - t;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(t).toLocaleDateString();
}

export function TokensPage() {
  const { data: tokens, isLoading } = trpc.tokens.listCustom.useQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<{
    tokenId: string;
    tokenSymbol: string;
    currentPrice: string | null;
    currentBaseCurrency: string | null;
  } | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-36" />
        </div>
        <div className="space-y-2">
          {SKELETON_KEYS.map((k) => (
            <Skeleton key={`tokens-skel-${k}`} className="h-16" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Custom Tokens</h2>
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

      {tokens && tokens.length > 0 ? (
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
                    {formatRelative(t.latestPriceAt as unknown as string | Date | null)}
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
