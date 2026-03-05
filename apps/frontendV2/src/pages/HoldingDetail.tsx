import { Save, Trash2, Vault } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Link, useNavigate, useParams } from 'react-router-dom';
import TimeAgo from 'react-timeago';
import { AccountBadge, InstitutionBadge, TokenTypeBadge } from '@/components/features';
import { TokenSearchableSelector } from '@/components/selectors/TokenSearchableSelector';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyDisplay } from '@/components/ui/money-display';
import { MultiSelect } from '@/components/ui/multi-select';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function HoldingDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [editTokenId, setEditTokenId] = useState('');
  const [editBalance, setEditBalance] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [isEditing, setIsEditing] = useState(false);

  // Fetch base currency
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  // Fetch all holdings to find the one we need
  const { data: allHoldings, isLoading } = trpc.holdings.getWithDetails.useQuery();
  const holding = allHoldings?.holdings?.find((h) => h.id === id);

  // Fetch groups and holding groups
  const { data: groups } = trpc.groups.getAll.useQuery();
  const { data: holdingGroups } = trpc.groups.getHoldingGroups.useQuery(
    { id: id || '' },
    { enabled: !!id }
  );

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

      setIsEditing(false);
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

      // Navigate back to holdings page
      navigate('/holdings');
    },
    onError: (error) => showError(error, 'Deleting holding'),
  });

  // Assign groups mutation
  const assignGroupsMutation = trpc.groups.assignHoldingGroups.useMutation({
    onSuccess: () => {
      utils.groups.getHoldingGroups.invalidate();
      utils.holdings.getWithDetails.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: 'Groups updated',
        description: 'Holding groups have been successfully updated.',
      });

      setIsEditing(false);
    },
    onError: (error) => showError(error, 'Updating groups'),
  });

  // Reset edit state when holding changes
  useEffect(() => {
    if (holding) {
      setEditTokenId(holding.token?.id || '');
      setEditBalance(holding.amount.toString());
      setEditIsActive(holding.isActive);
    }
  }, [holding]);

  // Update selected groups when holding groups are loaded
  useEffect(() => {
    if (holdingGroups) {
      setSelectedGroups(holdingGroups.map((g) => g.id));
    }
  }, [holdingGroups]);

  // Check if there are any changes
  const hasChanges = () => {
    if (!holding) return false;
    const originalGroups = holdingGroups?.map((g) => g.id).sort() || [];
    const currentGroups = [...selectedGroups].sort();
    const groupsChanged = JSON.stringify(originalGroups) !== JSON.stringify(currentGroups);

    return (
      editTokenId !== (holding.token?.id || '') ||
      editBalance !== holding.amount.toString() ||
      editIsActive !== holding.isActive ||
      groupsChanged
    );
  };

  const handleSave = async () => {
    if (!holding || !editBalance?.trim()) return;

    const updateData: {
      balance?: string;
      tokenId?: string;
      isActive?: boolean;
    } = {};

    // Only include changed fields
    if (editBalance !== holding.amount.toString()) {
      updateData.balance = editBalance;
    }

    if (editTokenId !== (holding.token?.id || '')) {
      updateData.tokenId = editTokenId;
    }

    if (editIsActive !== holding.isActive) {
      updateData.isActive = editIsActive;
    }

    // Check if groups changed
    const originalGroups = holdingGroups?.map((g) => g.id).sort() || [];
    const currentGroups = [...selectedGroups].sort();
    const groupsChanged = JSON.stringify(originalGroups) !== JSON.stringify(currentGroups);

    // Update holding data if changed
    if (Object.keys(updateData).length > 0) {
      updateHoldingMutation.mutate({
        id: holding.id,
        data: updateData,
      });
    }

    // Update groups if changed
    if (groupsChanged) {
      assignGroupsMutation.mutate({
        holdingId: holding.id,
        groupIds: selectedGroups,
      });
    }
  };

  const handleDelete = () => {
    if (!holding) return;

    const confirmed = window.confirm(
      'Are you sure you want to delete this holding? This action cannot be undone.'
    );
    if (confirmed) {
      deleteHoldingMutation.mutate({ id: holding.id });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="" loading={true} />

        {/* Skeleton content */}
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div>
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-10 w-full" />
              </div>
              <div>
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-10 w-full" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div>
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-10 w-full" />
              </div>
              <div>
                <Skeleton className="h-4 w-24 mb-2" />
                <Skeleton className="h-10 w-full" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!holding) {
    return (
      <div className="space-y-6">
        <PageHeader title="Holding Not Found" subtitle="The requested holding could not be found" />
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              This holding may have been deleted or does not exist.
            </p>
            <Button variant="outline" onClick={() => navigate('/holdings')} className="mt-4">
              Back to Holdings
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={holding.token?.symbol || holding.token?.name || 'Holding'}
        subtitle={holding.token?.name ? `${holding.token.name} holding details` : 'Holding details'}
        secondaryActions={
          <div className="flex gap-2">
            {isEditing ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsEditing(false);
                    setEditTokenId(holding.token?.id || '');
                    setEditBalance(holding.amount.toString());
                    setEditIsActive(holding.isActive);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={
                    updateHoldingMutation.isPending || !editBalance?.trim() || !hasChanges()
                  }
                >
                  <Save className="h-4 w-4 mr-2" />
                  Save Changes
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleteHoldingMutation.isPending}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="grid gap-6 md:grid-cols-2">
        {/* Token Information */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Token</Label>
              <div className="mt-1">
                {isEditing ? (
                  <TokenSearchableSelector
                    value={editTokenId}
                    onValueChange={setEditTokenId}
                    placeholder="Search tokens..."
                    allowCreateNew={false}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-medium">{holding.token.symbol}</span>
                    {holding.token?.typeCode && (
                      <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-muted-foreground">Token Name</Label>
              <div className="mt-1 text-base">{holding.token.name}</div>
            </div>

            <div>
              <Label className="text-sm font-medium text-muted-foreground">Balance</Label>
              <div className="mt-1">
                {isEditing ? (
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
                ) : (
                  <div className="text-2xl font-bold font-mono">{holding.amount.toString()}</div>
                )}
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-muted-foreground">Value</Label>
              <div className="mt-1">
                <MoneyDisplay
                  value={holding.value}
                  token={baseCurrencyToken}
                  className="text-2xl font-bold"
                />
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium text-muted-foreground">Status</Label>
              <div className="mt-2 flex items-center gap-3">
                {isEditing ? (
                  <>
                    <Switch
                      id="holding-active-toggle"
                      checked={editIsActive}
                      onCheckedChange={setEditIsActive}
                      aria-label="Toggle holding active status"
                    />
                    <Label htmlFor="holding-active-toggle" className="cursor-pointer font-normal">
                      {editIsActive ? 'Active' : 'Inactive'}
                    </Label>
                  </>
                ) : (
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      holding.isActive
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400'
                    }`}
                  >
                    {holding.isActive ? 'Active' : 'Inactive'}
                  </span>
                )}
              </div>
              {isEditing && (
                <p className="text-xs text-muted-foreground mt-2">
                  Inactive holdings are visible but excluded from portfolio calculations
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Price & Account Information */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Price</Label>
              <div className="mt-1">
                <MoneyDisplay
                  value={holding.price?.value ? parseFloat(holding.price.value) : 0}
                  token={baseCurrencyToken}
                  className="text-lg font-medium"
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
          </CardContent>
        </Card>
      </div>

      {/* Groups */}
      <Card>
        <CardContent className="pt-6">
          <div>
            <Label className="text-sm font-medium text-muted-foreground">Groups</Label>
            <div className="mt-2">
              {isEditing ? (
                <MultiSelect
                  selected={selectedGroups}
                  onSelectedChange={setSelectedGroups}
                  placeholder="Select groups..."
                  searchPlaceholder="Search groups..."
                  emptyMessage="No groups found."
                  items={
                    groups?.map((group) => ({
                      value: group.id,
                      label: group.name,
                      color: group.color,
                    })) || []
                  }
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {holdingGroups && holdingGroups.length > 0 ? (
                    holdingGroups.map((group) => (
                      <span
                        key={group.id}
                        className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                        style={{
                          backgroundColor: `${group.color}20`,
                          color: group.color,
                        }}
                      >
                        {group.name}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">No groups assigned</span>
                  )}
                </div>
              )}
            </div>
            {isEditing && (
              <p className="text-xs text-muted-foreground mt-2">
                Assign this holding to one or more groups for better organization
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Vaults */}
      <VaultsSection holdingId={id} />

      {/* Timestamps */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-2 gap-4">
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
        </CardContent>
      </Card>
    </div>
  );
}

function VaultsSection({ holdingId }: { holdingId: string | undefined }) {
  const { data: vaults } = trpc.vaults.getByHoldingId.useQuery(
    { holdingId: holdingId! },
    { enabled: !!holdingId }
  );

  if (!vaults || vaults.length === 0) return null;

  return (
    <Card>
      <CardContent className="pt-6">
        <div>
          <Label className="text-sm font-medium text-muted-foreground">Vaults</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {vaults.map((v) => (
              <Link
                key={v.id}
                to={`/vaults/${v.id}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium hover:opacity-80 transition-opacity"
                style={{
                  backgroundColor: `${v.color}20`,
                  color: v.color,
                }}
              >
                <Vault className="h-3 w-3" />
                {v.name}
                <span className="opacity-70">({v.percentage}%)</span>
              </Link>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
