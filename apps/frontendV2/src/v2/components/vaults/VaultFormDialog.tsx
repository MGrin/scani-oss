import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

const COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#64748b',
];

interface VaultFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId?: string | null;
}

export function VaultFormDialog({ open, onOpenChange, vaultId }: VaultFormDialogProps) {
  const utils = trpc.useUtils();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const { data: vault } = trpc.vaults.getById.useQuery({ id: vaultId! }, { enabled: !!vaultId });

  const isEditMode = !!vaultId;

  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [color, setColor] = useState(COLORS[0]!);

  // Pre-fill form when editing
  useEffect(() => {
    if (vault && isEditMode) {
      setName(vault.name);
      setTargetAmount(vault.targetAmount);
      setColor(vault.color);
    } else if (!isEditMode) {
      setName('');
      setTargetAmount('');
      setColor(COLORS[0]!);
    }
  }, [vault, isEditMode]);

  const createMutation = trpc.vaults.create.useMutation({
    onSuccess: () => {
      utils.vaults.invalidate();
      onOpenChange(false);
      setName('');
      setTargetAmount('');
      showSuccess('Vault created successfully');
    },
    onError: (error) => showError(error, 'Failed to create vault'),
  });

  const updateMutation = trpc.vaults.update.useMutation({
    onSuccess: () => {
      utils.vaults.invalidate();
      onOpenChange(false);
      showSuccess('Vault updated successfully');
    },
    onError: (error) => showError(error, 'Failed to update vault'),
  });

  const handleSubmit = () => {
    if (!name.trim() || !targetAmount) return;

    if (isEditMode && vaultId) {
      updateMutation.mutate({
        id: vaultId,
        data: {
          name: name.trim(),
          targetAmount,
          color,
        },
      });
    } else {
      if (!baseCurrency?.id) return;
      createMutation.mutate({
        name: name.trim(),
        targetAmount,
        currencyId: baseCurrency.id,
        color,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Vault' : 'New Vault'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="vault-name">Name</Label>
            <Input
              id="vault-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Emergency Fund"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="vault-target">Target Amount ({baseCurrency?.symbol || 'USD'})</Label>
            <Input
              id="vault-target"
              type="number"
              value={targetAmount}
              onChange={(e) => setTargetAmount(e.target.value)}
              placeholder="10000"
              min="0"
              step="100"
            />
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    borderColor: color === c ? 'var(--foreground)' : 'transparent',
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || !targetAmount || isPending}>
            {isEditMode ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
