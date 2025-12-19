import type { HoldingWithDetails } from '@scani/shared';
import { RefreshCw, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import TimeAgo from 'react-timeago';
import { TokenSearchableSelector } from '@/components/selectors/TokenSearchableSelector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { MoneyDisplay } from '@/components/ui/money-display';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';
import { AccountBadge } from './AccountBadge';
import { InstitutionBadge } from './InstitutionBadge';
import { TokenTypeBadge } from './TokenTypeBadge';

interface HoldingModalProps {
  holding: HoldingWithDetails | null;
  isOpen: boolean;
  onClose: () => void;
  onHoldingUpdated?: () => void;
  onHoldingDeleted?: () => void;
}

export function HoldingModal({
  holding,
  isOpen,
  onClose,
  onHoldingUpdated,
  onHoldingDeleted,
}: HoldingModalProps) {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [editTokenId, setEditTokenId] = useState('');
  const [editBalance, setEditBalance] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);

  // Fetch base currency
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  // Update holding mutation
  const updateHoldingMutation = trpc.holdings.update.useMutation({
    onSuccess: () => {
      // Invalidate all holding-related queries
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getHoldings.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: 'Holding updated',
        description: 'The holding has been successfully updated.',
      });

      onHoldingUpdated?.();
    },
    onError: (error) => showError(error, 'Updating holding'),
  });

  // Delete holding mutation
  const deleteHoldingMutation = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      // Invalidate all holding-related queries
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getHoldings.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: 'Holding deleted',
        description: 'The holding has been successfully deleted.',
      });

      onClose();
      onHoldingDeleted?.();
    },
    onError: (error) => showError(error, 'Deleting holding'),
  });

  // Update price mutation
  const updatePriceMutation = trpc.holdings.updatePrice.useMutation({
    onSuccess: (data) => {
      // Invalidate all holding-related queries to refresh the data
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getHoldings.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: 'Price updated',
        description: `Price refreshed successfully from ${data.source}.`,
      });

      onHoldingUpdated?.();
    },
    onError: (error) => showError(error, 'Updating price'),
  });

  // Reset edit state when holding changes
  useEffect(() => {
    if (holding) {
      setEditTokenId(holding.token?.id || '');
      setEditBalance(holding.amount.toString());
      setEditIsActive(holding.isActive);
    }
  }, [holding]);

  // Check if there are any changes
  const hasChanges = () => {
    if (!holding) return false;
    return (
      editTokenId !== (holding.token?.id || '') ||
      editBalance !== holding.amount.toString() ||
      editIsActive !== holding.isActive
    );
  };

  const handleSave = () => {
    if (!holding) return;

    const updateData: { balance?: string; tokenId?: string; isActive?: boolean } = {};

    // Only include changed fields
    if (editBalance?.trim() && editBalance !== holding.amount.toString()) {
      updateData.balance = editBalance;
    }

    if (editTokenId !== (holding.token?.id || '')) {
      updateData.tokenId = editTokenId;
    }

    if (editIsActive !== holding.isActive) {
      updateData.isActive = editIsActive;
    }

    // Ensure at least one field is being updated
    if (Object.keys(updateData).length === 0) {
      return;
    }

    updateHoldingMutation.mutate({
      id: holding.id,
      data: updateData,
    });
  };

  const handleDelete = () => {
    if (!holding) return;

    deleteHoldingMutation.mutate({ id: holding.id });
  };

  const handleUpdatePrice = () => {
    if (!holding) return;

    updatePriceMutation.mutate({ id: holding.id });
  };

  if (!holding) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {holding?.token?.symbol || holding?.token?.name || 'Holding'}
            {holding?.token?.typeCode && <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />}
          </DialogTitle>
          <DialogDescription>
            {holding?.token?.name ? `${holding.token.name} holding details` : 'Holding details'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Token Information */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Token</Label>
              <div className="mt-1">
                <TokenSearchableSelector
                  value={editTokenId}
                  onValueChange={setEditTokenId}
                  placeholder="Search tokens..."
                  allowCreateNew={false}
                />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Type</Label>
              <div className="mt-1">
                {holding.token?.typeCode && (
                  <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
                )}
              </div>
            </div>
          </div>

          {/* Account & Institution */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Account</Label>
              <div className="mt-1">
                {holding.account ? (
                  <AccountBadge
                    accountId={holding.account.id}
                    accountName={holding.account.name}
                    accountTypeCode={holding.account.typeCode}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">Unknown Account</span>
                )}
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Institution</Label>
              <div className="mt-1">
                {holding.institution ? (
                  <InstitutionBadge
                    institutionId={holding.institution.id}
                    institutionName={holding.institution.name}
                    institutionWebsite={holding.institution.website ?? undefined}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">Unknown Institution</span>
                )}
              </div>
            </div>
          </div>

          {/* Balance & Value */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Balance</Label>
              <div className="mt-1">
                <NumericFormat
                  value={editBalance || ''}
                  onValueChange={(values) => setEditBalance(values.value)}
                  placeholder="0.00"
                  customInput={Input}
                  thousandSeparator=","
                  decimalSeparator="."
                  decimalScale={8}
                  allowNegative={false}
                />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Value</Label>
              <div className="mt-1">
                <MoneyDisplay
                  value={holding.value}
                  token={baseCurrencyToken}
                  className="font-medium"
                />
              </div>
            </div>
          </div>

          {/* Price Information */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Price</Label>
              <div className="mt-1">
                <MoneyDisplay
                  value={holding.price?.value ? parseFloat(holding.price.value) : 0}
                  token={baseCurrencyToken}
                />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Price Source</Label>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-sm">{holding.price?.source || 'No price available'}</span>
                {holding.price?.timestamp && (
                  <>
                    <span className="text-sm text-muted-foreground">•</span>
                    <span className="text-sm text-muted-foreground">
                      <TimeAgo date={new Date(holding.price.timestamp)} />
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Update Price Button */}
          <div className="flex justify-start">
            <Button
              variant="outline"
              size="sm"
              onClick={handleUpdatePrice}
              disabled={updatePriceMutation.isPending}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${updatePriceMutation.isPending ? 'animate-spin' : ''}`}
              />
              {updatePriceMutation.isPending ? 'Updating Price...' : 'Update Price'}
            </Button>
          </div>

          {/* Timestamps */}
          <div className="grid grid-cols-2 gap-4 pt-4 border-t">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Last Updated</Label>
              <div className="mt-1">
                <TimeAgo date={holding.lastUpdated ? new Date(holding.lastUpdated) : new Date()} />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Created</Label>
              <div className="mt-1">
                <TimeAgo date={holding.createdAt ? new Date(holding.createdAt) : new Date()} />
              </div>
            </div>
          </div>

          {/* Active Status Toggle */}
          <div className="flex items-center space-x-2 pt-4 border-t">
            <Checkbox
              id="isActive"
              checked={editIsActive}
              onCheckedChange={(checked) => setEditIsActive(checked === true)}
            />
            <Label
              htmlFor="isActive"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
            >
              Include in total balance calculations
            </Label>
          </div>
          {!editIsActive && (
            <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
              When unchecked, this holding will still be visible but won't be included in portfolio
              totals, asset allocation, or dashboard statistics.
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between">
          <div>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleteHoldingMutation.isPending}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Holding
            </Button>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={updateHoldingMutation.isPending || !editBalance?.trim() || !hasChanges()}
            >
              <Save className="h-4 w-4 mr-2" />
              Save Changes
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
