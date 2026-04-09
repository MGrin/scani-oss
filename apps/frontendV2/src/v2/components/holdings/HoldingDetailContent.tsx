import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { useHoldingActions } from '../../hooks/useHoldingActions';
import { V2_ROUTES } from '../../lib/routes';
import { ConfirmDialog } from '../shared/ConfirmDialog';

function formatMoney(value: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

interface HoldingDetailContentProps {
  holdingId: string;
  mode?: 'panel' | 'fullPage';
  onClose?: () => void;
}

export function HoldingDetailContent({ holdingId, mode = 'panel' }: HoldingDetailContentProps) {
  const { symbol: currencySymbol } = useBaseCurrency();
  const { data: holdingsData, isLoading } = trpc.holdings.getWithDetails.useQuery();
  const holding = holdingsData?.holdings?.find((h: { id: string }) => h.id === holdingId);
  const { deleteHolding, updateHolding, refreshPrice, isDeleting, isRefreshingPrice } =
    useHoldingActions();
  const navigate = useNavigate();

  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceInput, setBalanceInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!holding) {
    return <p className="text-muted-foreground text-sm">Holding not found</p>;
  }

  const isCompact = mode === 'panel';
  const value = typeof holding.value === 'number' ? holding.value : 0;
  const costBasis = typeof holding.costBasis === 'number' ? holding.costBasis : 0;
  const gainLoss = costBasis > 0 ? value - costBasis : null;
  const gainLossPct = costBasis > 0 ? ((value - costBasis) / costBasis) * 100 : null;
  const favicon = getFaviconUrl(holding.institution?.website);

  const startEditBalance = () => {
    setBalanceInput(String(holding.amount));
    setEditingBalance(true);
  };

  const saveBalance = () => {
    if (balanceInput.trim()) {
      updateHolding(holdingId, { balance: balanceInput.trim() });
    }
    setEditingBalance(false);
  };

  return (
    <div className={cn('space-y-6', isCompact && 'space-y-4')}>
      {/* Header with actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className={cn('font-semibold', isCompact ? 'text-lg' : 'text-2xl')}>
              {holding.token.symbol}
            </h2>
            <Badge variant="outline" className="text-xs">
              {holding.token.type || holding.token.typeCode}
            </Badge>
            {holding.source && (
              <Badge variant="secondary" className="text-[10px]">
                {holding.source}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{holding.token.name}</p>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refreshPrice(holdingId)}
            disabled={isRefreshingPrice}
            title="Refresh price"
          >
            <RefreshCw className={cn('h-4 w-4', isRefreshingPrice && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isDeleting}
            title="Delete holding"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Value section */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Value</p>
          <p className="text-xl font-semibold mt-0.5">{formatMoney(value, currencySymbol)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Amount</p>
          {editingBalance ? (
            <div className="flex gap-2 mt-0.5">
              <NumericFormat
                value={balanceInput}
                onValueChange={(values) => setBalanceInput(values.value)}
                customInput={Input}
                className="h-8 text-sm"
                thousandSeparator=","
                decimalSeparator="."
                decimalScale={8}
                allowNegative={false}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveBalance();
                  if (e.key === 'Escape') setEditingBalance(false);
                }}
              />
              <Button size="sm" className="h-8" onClick={saveBalance}>
                Save
              </Button>
            </div>
          ) : (
            <p className="text-xl font-semibold mt-0.5 flex items-center gap-2">
              {typeof holding.amount === 'number'
                ? holding.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })
                : holding.amount}
              <button
                type="button"
                onClick={startEditBalance}
                className="text-muted-foreground hover:text-foreground"
                title="Edit balance"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </p>
          )}
        </div>
      </div>

      {/* P&L section */}
      {gainLoss !== null && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Cost Basis</p>
            <p className="text-sm font-medium mt-0.5">{formatMoney(costBasis, currencySymbol)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Gain / Loss</p>
            <p
              className={cn(
                'text-sm font-medium mt-0.5',
                gainLoss >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              )}
            >
              {gainLoss >= 0 ? '+' : ''}
              {formatMoney(gainLoss, currencySymbol)} ({gainLossPct!.toFixed(1)}%)
            </p>
          </div>
        </div>
      )}

      <Separator />

      {/* Details */}
      <div className="space-y-3">
        <DetailRow
          label="Price"
          value={
            holding.price?.value ? (
              <span className="flex flex-col items-end gap-0.5">
                <span>{formatMoney(Number(holding.price.value), currencySymbol)}</span>
                <span className="text-[10px] text-muted-foreground/70">
                  {holding.price.timestamp ? formatRelativeTime(holding.price.timestamp) : ''}
                  {holding.price.source ? ` · ${holding.price.source}` : ''}
                </span>
              </span>
            ) : (
              'N/A'
            )
          }
        />
        <DetailRow label="Account" value={holding.account?.name || '-'} />
        <DetailRow
          label="Institution"
          value={
            <span className="inline-flex items-center gap-1">
              {favicon && (
                <img
                  src={favicon}
                  alt=""
                  className="h-3.5 w-3.5 rounded-sm object-contain"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              {holding.institution?.name || '-'}
            </span>
          }
        />
        <DetailRow
          label="Status"
          value={
            <button
              type="button"
              onClick={() => updateHolding(holdingId, { isActive: !holding.isActive })}
              className="cursor-pointer"
              title={`Click to ${holding.isActive ? 'deactivate' : 'activate'}`}
            >
              <Badge variant={holding.isActive ? 'default' : 'secondary'} className="text-xs">
                {holding.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </button>
          }
        />
        <DetailRow
          label="Last Updated"
          value={holding.lastUpdated ? formatRelativeTime(holding.lastUpdated) : '-'}
        />
        {holding.source && holding.source !== 'manual' && (
          <DetailRow
            label="Data Source"
            value={
              <Badge variant="outline" className="text-xs">
                {holding.source.replace('import_', '').replace('_', ' ')}
              </Badge>
            }
          />
        )}
      </div>

      {holding.groups && holding.groups.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Groups</p>
            <div className="flex flex-wrap gap-1.5">
              {holding.groups.map((g: { id: string; name: string; color?: string }) => (
                <Badge
                  key={g.id}
                  variant="outline"
                  className="text-xs"
                  style={g.color ? { borderColor: g.color, color: g.color } : undefined}
                >
                  {g.name}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Holding"
        description={`Are you sure you want to delete ${holding.token.symbol}? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          deleteHolding(holdingId);
          navigate(V2_ROUTES.holdings);
        }}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
