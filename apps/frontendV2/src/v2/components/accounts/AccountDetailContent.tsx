import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useAccountActions } from '../../hooks/useAccountActions';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { V2_ROUTES } from '../../lib/routes';
import { ConfirmDialog } from '../shared/ConfirmDialog';

interface AccountDetailContentProps {
  accountId: string;
  mode?: 'panel' | 'fullPage';
}

export function AccountDetailContent({ accountId, mode = 'panel' }: AccountDetailContentProps) {
  const { data: account, isLoading } = trpc.accounts.getById.useQuery({ id: accountId });
  const { data: holdingsData } = trpc.accounts.getHoldings.useQuery({ id: accountId });
  const { symbol: currencySymbol } = useBaseCurrency();
  const { deleteAccount, updateAccount, isUpdating } = useAccountActions();
  const navigate = useNavigate();

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!account) {
    return <p className="text-muted-foreground text-sm">Account not found</p>;
  }

  const isCompact = mode === 'panel';
  const holdings = Array.isArray(holdingsData) ? holdingsData : holdingsData?.holdings || [];

  const startEditing = () => {
    setEditName(account.name);
    setEditDescription(account.description || '');
    setIsEditing(true);
  };

  const saveEdit = () => {
    updateAccount(accountId, {
      name: editName.trim(),
      description: editDescription.trim() || null,
    });
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setIsEditing(false);
  };

  return (
    <div className={cn('space-y-6', isCompact && 'space-y-4')}>
      {isEditing ? (
        <div className="space-y-3">
          <div>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Account name"
              className="font-semibold"
            />
          </div>
          <div>
            <Input
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Description (optional)"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveEdit} disabled={!editName.trim() || isUpdating}>
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-start justify-between">
            <div>
              <h2 className={cn('font-semibold', isCompact ? 'text-lg' : 'text-2xl')}>
                {account.name}
              </h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {account.description || 'No description'}
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button size="sm" variant="ghost" onClick={startEditing}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Holdings</p>
          <p className="text-xl font-semibold mt-0.5">{holdings.length}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Status</p>
          <Badge variant={account.isActive ? 'default' : 'secondary'} className="mt-1">
            {account.isActive ? 'Active' : 'Inactive'}
          </Badge>
        </div>
      </div>

      {/* Sync info */}
      {(() => {
        const meta = account.metadata as Record<string, string> | null | undefined;
        const lastSync = meta?.lastSync;
        if (!lastSync) return null;
        return (
          <div className="rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span>Last synced: </span>
            <span className="font-medium text-foreground">
              {new Date(lastSync).toLocaleString()}
            </span>
          </div>
        );
      })()}

      <Separator />

      {/* Holdings list */}
      {holdings.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Holdings</p>
          <div className="space-y-1">
            {[...holdings]
              .sort(
                (a: { value?: number }, b: { value?: number }) =>
                  (Number(b.value) || 0) - (Number(a.value) || 0)
              )
              .slice(0, 20)
              .map(
                (h: {
                  id: string;
                  token?: { symbol: string; name?: string; typeCode?: string };
                  balance?: string;
                  value?: number;
                  source?: string;
                  isActive?: boolean;
                }) => (
                  <button
                    type="button"
                    key={h.id}
                    className="flex items-center gap-3 w-full p-2 rounded-md hover:bg-accent/50 transition-colors text-left border border-transparent hover:border-border"
                    onClick={() => navigate(V2_ROUTES.holdingDetail(h.id))}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-sm">{h.token?.symbol || 'Unknown'}</span>
                        {h.token?.typeCode && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0">
                            {h.token.typeCode}
                          </Badge>
                        )}
                        {h.isActive === false && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0">
                            inactive
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {[
                          h.balance
                            ? `${Number(h.balance).toLocaleString()} ${h.token?.symbol || ''}`
                            : null,
                          h.token?.name || null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <span className="text-sm font-semibold tabular-nums shrink-0">
                      {new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: currencySymbol,
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }).format(Number(h.value || 0))}
                    </span>
                  </button>
                )
              )}
            {holdings.length > 20 && (
              <p className="text-xs text-muted-foreground px-2 mt-1">
                +{holdings.length - 20} more holdings
              </p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Account"
        description={`Are you sure you want to delete "${account.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          deleteAccount(accountId);
          navigate(V2_ROUTES.accounts);
        }}
      />
    </div>
  );
}
