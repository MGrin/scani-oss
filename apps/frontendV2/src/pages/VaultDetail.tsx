import { GROUP_COLORS } from '@scani/shared';
import { Check, Pencil, Plus, Search, Trash2, Vault, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AccountBadge, InstitutionBadge, TokenTypeBadge } from '@/components/features';
import { CurrencySelector } from '@/components/selectors/CurrencySelector';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const { data: vault, isLoading } = trpc.vaults.getById.useQuery({ id: id! }, { enabled: !!id });

  const { data: allHoldings } = trpc.holdings.getWithDetails.useQuery();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const { data: currencies } = trpc.users.getSupportedCurrencies.useQuery();
  const baseCurrencyToken = createCurrencyToken(baseCurrency?.symbol || 'USD');
  const vaultCurrencyToken = createCurrencyToken(
    vault?.currencySymbol || baseCurrency?.symbol || 'USD'
  );

  // Build a lookup map from allHoldings for badge data
  const holdingsLookup = useMemo(() => {
    const map = new Map<string, NonNullable<typeof allHoldings>['holdings'][number]>();
    for (const h of allHoldings?.holdings || []) {
      map.set(h.id, h);
    }
    return map;
  }, [allHoldings]);

  const [isAttachDialogOpen, setIsAttachDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [selectedHoldingId, setSelectedHoldingId] = useState('');
  const [percentage, setPercentage] = useState('100');
  const [holdingSearch, setHoldingSearch] = useState('');
  const [editForm, setEditForm] = useState({
    name: '',
    targetAmount: '',
    currencyId: '',
    color: '',
    description: '',
  });

  const updateVaultMutation = trpc.vaults.update.useMutation({
    onSuccess: () => {
      utils.vaults.getById.invalidate({ id: id! });
      utils.vaults.getAll.invalidate();
      toast({ title: 'Vault updated', description: 'Your vault has been updated.' });
      setIsEditDialogOpen(false);
    },
    onError: (error) => showError(error, 'Updating vault'),
  });

  const deleteVaultMutation = trpc.vaults.delete.useMutation({
    onSuccess: () => {
      utils.vaults.getAll.invalidate();
      toast({ title: 'Vault deleted', description: 'The vault has been deleted.' });
      navigate('/vaults');
    },
    onError: (error) => showError(error, 'Deleting vault'),
  });

  const attachMutation = trpc.vaults.attachHolding.useMutation({
    onSuccess: () => {
      utils.vaults.getById.invalidate({ id: id! });
      utils.vaults.getAll.invalidate();
      toast({
        title: 'Holding attached',
        description: 'The holding has been added to this vault.',
      });
      setIsAttachDialogOpen(false);
      setSelectedHoldingId('');
      setPercentage('100');
    },
    onError: (error) => showError(error, 'Attaching holding'),
  });

  const detachMutation = trpc.vaults.detachHolding.useMutation({
    onSuccess: () => {
      utils.vaults.getById.invalidate({ id: id! });
      utils.vaults.getAll.invalidate();
      toast({
        title: 'Holding detached',
        description: 'The holding has been removed from this vault.',
      });
    },
    onError: (error) => showError(error, 'Detaching holding'),
  });

  const updatePercentageMutation = trpc.vaults.updateHoldingPercentage.useMutation({
    onSuccess: () => {
      utils.vaults.getById.invalidate({ id: id! });
      utils.vaults.getAll.invalidate();
      toast({ title: 'Percentage updated' });
    },
    onError: (error) => showError(error, 'Updating percentage'),
  });

  const handleEdit = () => {
    if (!vault) return;
    setEditForm({
      name: vault.name,
      targetAmount: vault.targetAmount,
      currencyId: vault.currencyId,
      color: vault.color,
      description: vault.description || '',
    });
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!id) return;
    updateVaultMutation.mutate({
      id,
      data: {
        name: editForm.name,
        targetAmount: editForm.targetAmount,
        currencyId: editForm.currencyId,
        color: editForm.color,
        description: editForm.description || null,
      },
    });
  };

  const handleDelete = () => {
    if (!id) return;
    if (
      window.confirm(`Are you sure you want to delete "${vault?.name}"? This cannot be undone.`)
    ) {
      deleteVaultMutation.mutate({ id });
    }
  };

  const handleAttach = () => {
    if (!id || !selectedHoldingId) return;
    attachMutation.mutate({
      vaultId: id,
      holdingId: selectedHoldingId,
      percentage: Number.parseFloat(percentage),
    });
  };

  const handleDetach = (holdingId: string) => {
    if (!id) return;
    if (window.confirm('Remove this holding from the vault?')) {
      detachMutation.mutate({ vaultId: id, holdingId });
    }
  };

  const handlePercentageBlur = (holdingId: string, newPercentage: string) => {
    if (!id) return;
    const pct = Number.parseFloat(newPercentage);
    if (Number.isNaN(pct) || pct <= 0 || pct > 100) return;

    const currentHolding = vault?.holdings.find((h) => h.holdingId === holdingId);
    if (currentHolding && currentHolding.percentage !== pct) {
      updatePercentageMutation.mutate({ vaultId: id, holdingId, percentage: pct });
    }
  };

  const formatAmount = (amount: string, symbol?: string) => {
    const num = Number.parseFloat(amount);
    if (Number.isNaN(num)) return symbol ? `${symbol} 0` : '0';
    const formatted = num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return symbol ? `${symbol} ${formatted}` : formatted;
  };

  // Filter available holdings (exclude those already attached), sorted by value desc
  const attachedHoldingIds = new Set(vault?.holdings.map((h) => h.holdingId) || []);
  const availableHoldings = useMemo(() => {
    const filtered =
      allHoldings?.holdings.filter((h) => !attachedHoldingIds.has(h.id) && !h.isHidden) || [];
    return [...filtered].sort((a, b) => b.value - a.value);
  }, [allHoldings, attachedHoldingIds]);

  const filteredAvailableHoldings = useMemo(() => {
    if (!holdingSearch) return availableHoldings;
    const q = holdingSearch.toLowerCase();
    return availableHoldings.filter(
      (h) =>
        h.token.symbol.toLowerCase().includes(q) ||
        h.token.name.toLowerCase().includes(q) ||
        h.account.name.toLowerCase().includes(q) ||
        h.institution.name.toLowerCase().includes(q)
    );
  }, [availableHoldings, holdingSearch]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="" loading={true} />
        <Card>
          <CardContent className="pt-6 space-y-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-4 w-32" />
          </CardContent>
        </Card>
        <div>
          <Skeleton className="h-6 w-40 mb-4" />
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-5 w-24" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-16 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="space-y-6">
        <PageHeader title="Vault Not Found" subtitle="The requested vault could not be found" />
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              This vault may have been deleted or does not exist.
            </p>
            <Button variant="outline" onClick={() => navigate('/vaults')} className="mt-4">
              Back to Vaults
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const progressClamped = Math.min(vault.progress, 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title={vault.name}
        subtitle={vault.description || undefined}
        backButton={{ onClick: () => navigate('/vaults') }}
        secondaryActions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleEdit}>
              <Pencil className="h-4 w-4 mr-1" />
              Edit
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleteVaultMutation.isPending}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>
          </div>
        }
      />

      {/* Progress Card */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 rounded-full" style={{ backgroundColor: vault.color }} />
            <div className="flex-1">
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-2xl font-bold">
                  {formatAmount(vault.currentAmount, vault.currencySymbol)}
                </span>
                <span className="text-muted-foreground">
                  of {formatAmount(vault.targetAmount, vault.currencySymbol)}
                </span>
              </div>
              <Progress value={progressClamped} className="h-3" />
              <p className="text-sm text-muted-foreground mt-2">
                {vault.progress.toFixed(1)}% of target reached
                {vault.progress >= 100 && ' 🎉'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Attached Holdings */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Attached Holdings</h2>
          <Button size="sm" onClick={() => setIsAttachDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Attach Holding
          </Button>
        </div>

        {vault.holdings.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Vault className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-muted-foreground mb-3">
                No holdings attached yet. Attach holdings to track progress toward your goal.
              </p>
              <Button size="sm" onClick={() => setIsAttachDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Attach First Holding
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {vault.holdings.map((holding) => {
              const fullHolding = holdingsLookup.get(holding.holdingId);
              return (
                <Card key={holding.holdingId} className="hover:shadow-md transition-shadow">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <Link
                        to={`/holdings/${holding.holdingId}`}
                        className="font-semibold hover:underline"
                      >
                        {holding.tokenSymbol || holding.tokenName}
                      </Link>
                      <div className="flex items-center gap-2">
                        {fullHolding && (
                          <TokenTypeBadge tokenTypeCode={fullHolding.token.typeCode} />
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleDetach(holding.holdingId)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardTitle>
                    <div className="flex items-center gap-2 flex-wrap">
                      {fullHolding ? (
                        <>
                          <AccountBadge
                            accountId={fullHolding.account.id}
                            accountName={fullHolding.account.name}
                            accountTypeCode={fullHolding.account.typeCode}
                          />
                          <InstitutionBadge
                            institutionId={fullHolding.institution.id}
                            institutionName={fullHolding.institution.name}
                            institutionWebsite={fullHolding.institution.website ?? undefined}
                          />
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {holding.accountName} · {holding.institutionName}
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent
                    className="cursor-pointer"
                    onClick={() => navigate(`/holdings/${holding.holdingId}`)}
                  >
                    <div className="space-y-2">
                      <div className="text-2xl font-bold">
                        {Number.parseFloat(holding.holdingBalance).toLocaleString()}{' '}
                        {holding.tokenSymbol}
                      </div>
                      <div className="text-lg font-semibold">
                        <MoneyDisplay value={holding.holdingValue} token={vaultCurrencyToken} />
                      </div>
                      <div className="flex items-center justify-between pt-2 border-t">
                        <div className="text-sm text-muted-foreground">
                          Attributed:{' '}
                          <span className="font-medium text-foreground">
                            <MoneyDisplay
                              value={holding.attributedValue}
                              token={vaultCurrencyToken}
                            />
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            className="w-16 h-7 text-xs text-center"
                            defaultValue={holding.percentage}
                            min={0.01}
                            max={100}
                            step={1}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => handlePercentageBlur(holding.holdingId, e.target.value)}
                          />
                          <span className="text-xs text-muted-foreground">%</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Attach Holding Dialog */}
      <Dialog
        open={isAttachDialogOpen}
        onOpenChange={(open) => {
          setIsAttachDialogOpen(open);
          if (!open) {
            setSelectedHoldingId('');
            setPercentage('100');
            setHoldingSearch('');
          }
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Attach Holding</DialogTitle>
            <DialogDescription>
              Select a holding and the percentage to attribute to this vault.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 flex-1 min-h-0 flex flex-col">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search holdings..."
                value={holdingSearch}
                onChange={(e) => setHoldingSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Holdings grid */}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 max-h-[40vh] pr-1">
              {filteredAvailableHoldings.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {holdingSearch
                    ? 'No holdings match your search.'
                    : 'No holdings available to attach.'}
                </div>
              ) : (
                filteredAvailableHoldings.map((h) => {
                  const isSelected = selectedHoldingId === h.id;
                  return (
                    <button
                      key={h.id}
                      type="button"
                      className={`w-full text-left rounded-md border p-3 transition-colors hover:bg-accent/50 ${
                        isSelected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-border'
                      }`}
                      onClick={() => setSelectedHoldingId(isSelected ? '' : h.id)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{h.token.symbol}</span>
                            <span className="text-xs text-muted-foreground truncate">
                              {h.token.name}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {h.account.name} · {h.institution.name}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <div className="text-right">
                            <div className="text-sm font-medium">
                              <MoneyDisplay value={h.value} token={baseCurrencyToken} />
                            </div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {Number.parseFloat(String(h.amount)).toLocaleString()}{' '}
                              {h.token.symbol}
                            </div>
                          </div>
                          {isSelected && <Check className="h-4 w-4 text-primary flex-shrink-0" />}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Percentage */}
            <div>
              <Label htmlFor="attach-percentage">Percentage (%)</Label>
              <NumericFormat
                id="attach-percentage"
                value={percentage}
                onValueChange={(values) => setPercentage(values.value)}
                customInput={Input}
                decimalScale={2}
                allowNegative={false}
                isAllowed={(values) => {
                  const { floatValue } = values;
                  return floatValue === undefined || (floatValue > 0 && floatValue <= 100);
                }}
                placeholder="100"
              />
              <p className="text-xs text-muted-foreground mt-1">
                What percentage of this holding should count toward this vault?
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAttachDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAttach} disabled={!selectedHoldingId || !percentage}>
              Attach
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Vault Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Vault</DialogTitle>
            <DialogDescription>Update your vault details.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-vault-name">Name</Label>
              <Input
                id="edit-vault-name"
                placeholder="e.g. Wedding Fund"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="edit-vault-target">Target Amount</Label>
              <NumericFormat
                id="edit-vault-target"
                value={editForm.targetAmount}
                onValueChange={(values) => setEditForm({ ...editForm, targetAmount: values.value })}
                placeholder="5,000.00"
                customInput={Input}
                thousandSeparator=","
                decimalSeparator="."
                decimalScale={2}
                allowNegative={false}
              />
            </div>
            <div>
              <Label>Currency</Label>
              <CurrencySelector
                value={editForm.currencyId}
                onValueChange={(value) => setEditForm({ ...editForm, currencyId: value })}
                currencies={currencies}
                placeholder="Select currency..."
              />
              <p className="text-xs text-muted-foreground mt-1">
                Changing currency will recalculate all vault amounts.
              </p>
            </div>
            <div>
              <Label>Color</Label>
              <div className="grid grid-cols-9 gap-2 mt-2">
                {GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      editForm.color === color
                        ? 'border-foreground scale-110'
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => setEditForm({ ...editForm, color })}
                    aria-label={color}
                  />
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="edit-vault-desc">Description (optional)</Label>
              <Textarea
                id="edit-vault-desc"
                placeholder="What are you saving for?"
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={!editForm.name || !editForm.targetAmount}>
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
