import { useState } from 'react';
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
}

export function VaultFormDialog({ open, onOpenChange }: VaultFormDialogProps) {
  const utils = trpc.useUtils();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [color, setColor] = useState(COLORS[0]!);

  const createMutation = trpc.vaults.create.useMutation({
    onSuccess: () => {
      utils.vaults.invalidate();
      onOpenChange(false);
      setName('');
      setTargetAmount('');
    },
  });

  const handleSubmit = () => {
    if (!name.trim() || !targetAmount || !baseCurrency?.id) return;
    createMutation.mutate({
      name: name.trim(),
      targetAmount,
      currencyId: baseCurrency.id,
      color,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Vault</DialogTitle>
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
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || !targetAmount || createMutation.isPending}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
