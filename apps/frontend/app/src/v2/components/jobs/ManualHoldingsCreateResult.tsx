import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { AlertTriangle, ArrowRight, CheckCircle2, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useBaseCurrency } from '@/v2/hooks/useBaseCurrency';
import { V2_ROUTES } from '@/v2/lib/routes';

interface HoldingResultRow {
  id: string;
  tokenId: string;
  symbol: string;
  name: string;
  typeCode: string;
  balance: string;
  isUpdate: boolean;
  priceUsd?: string;
  priceSource?: string;
  error?: string;
}

interface ManualHoldingsCreateResultShape {
  institutionId: string | null;
  accountId: string;
  createdInstitution: boolean;
  createdAccount: boolean;
  holdings: HoldingResultRow[];
  parentJobId: string | null;
}

const TOKEN_TYPE_COLORS: Record<string, string> = {
  crypto: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  stock: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'public-stock': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  fiat: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  bond: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  commodity: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

function asResult(v: unknown): ManualHoldingsCreateResultShape | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.accountId !== 'string' || !Array.isArray(r.holdings)) return null;
  return r as unknown as ManualHoldingsCreateResultShape;
}

function computeValue(balance: string, priceUsd: string | undefined): number {
  if (!priceUsd) return 0;
  const b = Number(balance);
  const p = Number(priceUsd);
  if (!Number.isFinite(b) || !Number.isFinite(p)) return 0;
  return b * p;
}

export function ManualHoldingsCreateResult({ result }: { result: unknown }) {
  const navigate = useNavigate();
  const data = asResult(result);
  const { symbol: currency } = useBaseCurrency();

  if (!data) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          Job completed without a recognizable result payload.
        </CardContent>
      </Card>
    );
  }

  const priced = data.holdings.filter((h) => h.priceUsd && !h.error);
  const failed = data.holdings.filter((h) => h.error);
  const hasFailures = failed.length > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        {hasFailures ? (
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        )}
        <CardTitle className="text-sm">
          {hasFailures
            ? `Saved ${data.holdings.length} holdings — ${failed.length} need a price refresh`
            : `Saved ${data.holdings.length} holdings`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          {data.holdings.map((h) => {
            const value = computeValue(h.balance, h.priceUsd);
            const subtitle = [
              h.balance ? `${Number(h.balance).toLocaleString()} ${h.symbol}` : null,
              h.name && h.name !== h.symbol ? h.name : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <button
                type="button"
                key={h.id}
                className="flex items-center gap-3 w-full p-2 rounded-md hover:bg-accent/50 transition-colors text-left border border-transparent hover:border-border"
                onClick={() => navigate(V2_ROUTES.holdingDetail(h.id))}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm">{h.symbol || 'Unknown'}</span>
                    {h.typeCode && (
                      <Badge
                        variant="secondary"
                        className={cn(
                          'text-[9px] px-1 py-0',
                          TOKEN_TYPE_COLORS[h.typeCode.toLowerCase()] ?? 'bg-secondary'
                        )}
                      >
                        {h.typeCode}
                      </Badge>
                    )}
                    {h.isUpdate ? (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0 border-blue-500 text-blue-500"
                      >
                        updated
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0 border-green-500 text-green-500"
                      >
                        new
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle || '—'}</p>
                </div>
                <div className="text-right shrink-0">
                  {h.error ? (
                    <span className="text-xs text-amber-500 font-medium">Pricing failed</span>
                  ) : (
                    <>
                      <div className="text-sm font-semibold tabular-nums whitespace-nowrap">
                        {formatCurrency(value, currency)}
                      </div>
                      {h.priceSource && (
                        <div className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                          {h.priceSource}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-1">
          <span className="text-emerald-500">{priced.length} priced</span>
          {hasFailures && <span className="text-amber-500">{failed.length} unpriced</span>}
        </div>

        {hasFailures && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 space-y-1 text-xs">
            <div className="font-medium">Some prices couldn't be fetched right now.</div>
            <p className="text-muted-foreground">
              Holdings are saved. You can refresh prices individually from the holdings page, or
              wait — the next hourly pricing sweep retries automatically.
            </p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <Button asChild className="flex-1">
            <Link to={`${V2_ROUTES.holdings}?account=${encodeURIComponent(data.accountId)}`}>
              View holdings
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="flex-1">
            <Link to={V2_ROUTES.manualEntry}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add more
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
