import { GROUP_COLORS } from '@scani/shared';
import { Pencil, Plus, Trash2, Vault } from 'lucide-react';
import { useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { useNavigate } from 'react-router-dom';
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
import { PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function Vaults() {
  const navigate = useNavigate();
  const { data: vaults, isLoading } = trpc.vaults.getAll.useQuery();
  const { data: currencies } = trpc.users.getSupportedCurrencies.useQuery();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingVaultId, setEditingVaultId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    targetAmount: '',
    currencyId: '',
    color: GROUP_COLORS[10] as string, // blue default
    description: '',
  });

  const createVaultMutation = trpc.vaults.create.useMutation({
    onSuccess: () => {
      utils.vaults.getAll.invalidate();
      toast({ title: 'Vault created', description: 'Your savings vault has been created.' });
      setIsCreateDialogOpen(false);
      resetForm();
    },
    onError: (error) => showError(error, 'Creating vault'),
  });

  const updateVaultMutation = trpc.vaults.update.useMutation({
    onSuccess: () => {
      utils.vaults.getAll.invalidate();
      toast({ title: 'Vault updated', description: 'Your vault has been updated.' });
      setIsEditDialogOpen(false);
      setEditingVaultId(null);
      resetForm();
    },
    onError: (error) => showError(error, 'Updating vault'),
  });

  const deleteVaultMutation = trpc.vaults.delete.useMutation({
    onSuccess: () => {
      utils.vaults.getAll.invalidate();
      toast({ title: 'Vault deleted', description: 'The vault has been deleted.' });
    },
    onError: (error) => showError(error, 'Deleting vault'),
  });

  const resetForm = () => {
    setFormData({
      name: '',
      targetAmount: '',
      currencyId: currencies?.[0]?.id || '',
      color: GROUP_COLORS[10] as string,
      description: '',
    });
  };

  const handleCreate = () => {
    createVaultMutation.mutate({
      name: formData.name,
      targetAmount: formData.targetAmount,
      currencyId: formData.currencyId,
      color: formData.color,
      description: formData.description || null,
    });
  };

  const handleUpdate = () => {
    if (!editingVaultId) return;
    updateVaultMutation.mutate({
      id: editingVaultId,
      data: {
        name: formData.name,
        targetAmount: formData.targetAmount,
        currencyId: formData.currencyId,
        color: formData.color,
        description: formData.description || null,
      },
    });
  };

  const handleEditClick = (vault: NonNullable<typeof vaults>[number]) => {
    setEditingVaultId(vault.id);
    setFormData({
      name: vault.name,
      targetAmount: vault.targetAmount,
      currencyId: vault.currencyId,
      color: vault.color,
      description: vault.description || '',
    });
    setIsEditDialogOpen(true);
  };

  const handleDeleteClick = (vault: NonNullable<typeof vaults>[number]) => {
    if (window.confirm(`Are you sure you want to delete "${vault.name}"?`)) {
      deleteVaultMutation.mutate({ id: vault.id });
    }
  };

  const handleOpenCreate = () => {
    resetForm();
    const firstCurrency = currencies?.[0];
    if (firstCurrency) {
      setFormData((prev) => ({ ...prev, currencyId: firstCurrency.id }));
    }
    setIsCreateDialogOpen(true);
  };

  const formatAmount = (amount: string, symbol: string) => {
    const num = Number.parseFloat(amount);
    if (Number.isNaN(num)) return `${symbol} 0`;
    return `${symbol} ${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vaults"
        subtitle="Track your savings goals with dedicated vaults"
        primaryAction={{
          label: 'New Vault',
          onClick: handleOpenCreate,
          icon: <Plus className="h-4 w-4" />,
        }}
      />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !vaults || vaults.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Vault className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No vaults yet</h3>
            <p className="text-muted-foreground mb-4 max-w-md">
              Create a vault to start tracking savings for big goals like weddings, holidays, or
              major purchases.
            </p>
            <Button onClick={handleOpenCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Vault
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {vaults.map((vault) => {
            const progressClamped = Math.min(vault.progress, 100);
            return (
              <Card
                key={vault.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/vaults/${vault.id}`)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: vault.color }}
                      />
                      <CardTitle className="text-base truncate">{vault.name}</CardTitle>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditClick(vault);
                        }}
                      >
                        <span className="sr-only">Edit</span>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(vault);
                        }}
                      >
                        <span className="sr-only">Delete</span>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {vault.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                      {vault.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {formatAmount(vault.currentAmount, vault.currencySymbol)}
                    </span>
                    <span className="font-medium">
                      {formatAmount(vault.targetAmount, vault.currencySymbol)}
                    </span>
                  </div>
                  <Progress value={progressClamped} className="h-2.5" />
                  <div className="flex justify-between items-center text-xs text-muted-foreground">
                    <span>{vault.progress.toFixed(1)}% complete</span>
                    <span>
                      {vault.holdingsCount} holding{vault.holdingsCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog
        open={isCreateDialogOpen || isEditDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateDialogOpen(false);
            setIsEditDialogOpen(false);
            setEditingVaultId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEditDialogOpen ? 'Edit Vault' : 'Create New Vault'}</DialogTitle>
            <DialogDescription>
              {isEditDialogOpen
                ? 'Update your vault details.'
                : 'Set a savings goal and track your progress.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="vault-name">Name</Label>
              <Input
                id="vault-name"
                placeholder="e.g. Wedding Fund"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="vault-target">Target Amount</Label>
              <NumericFormat
                id="vault-target"
                value={formData.targetAmount}
                onValueChange={(values) => setFormData({ ...formData, targetAmount: values.value })}
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
                value={formData.currencyId}
                onValueChange={(value) => setFormData({ ...formData, currencyId: value })}
                currencies={currencies}
                placeholder="Select currency..."
              />
              {isEditDialogOpen && (
                <p className="text-xs text-muted-foreground mt-1">
                  Changing currency will recalculate all vault amounts.
                </p>
              )}
            </div>
            <div>
              <Label>Color</Label>
              <div className="grid grid-cols-9 gap-2 mt-2">
                {GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      formData.color === color
                        ? 'border-foreground scale-110'
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => setFormData({ ...formData, color })}
                    aria-label={color}
                  />
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="vault-desc">Description (optional)</Label>
              <Textarea
                id="vault-desc"
                placeholder="What are you saving for?"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateDialogOpen(false);
                setIsEditDialogOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={isEditDialogOpen ? handleUpdate : handleCreate}
              disabled={
                !formData.name ||
                !formData.targetAmount ||
                (!isEditDialogOpen && !formData.currencyId)
              }
            >
              {isEditDialogOpen ? 'Save Changes' : 'Create Vault'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
