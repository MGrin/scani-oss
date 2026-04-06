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
import { trpc } from '@/lib/trpc';

const COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
];

interface GroupFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string | null;
}

export function GroupFormDialog({ open, onOpenChange, groupId }: GroupFormDialogProps) {
  const utils = trpc.useUtils();
  const { data: groups } = trpc.groups.getAllWithCounts.useQuery();
  const group = groupId ? groups?.find((g) => g.id === groupId) : null;

  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]!);

  useEffect(() => {
    if (group) {
      setName(group.name);
      setColor(group.color);
    } else {
      setName('');
      setColor(COLORS[Math.floor(Math.random() * COLORS.length)]!);
    }
  }, [group]);

  const createMutation = trpc.groups.create.useMutation({
    onSuccess: () => {
      utils.groups.invalidate();
      onOpenChange(false);
    },
  });

  const updateMutation = trpc.groups.update.useMutation({
    onSuccess: () => {
      utils.groups.invalidate();
      onOpenChange(false);
    },
  });

  const deleteMutation = trpc.groups.delete.useMutation({
    onSuccess: () => {
      utils.groups.invalidate();
      onOpenChange(false);
    },
  });

  const handleSubmit = () => {
    if (!name.trim()) return;
    if (groupId) {
      updateMutation.mutate({ id: groupId, data: { name: name.trim(), color } });
    } else {
      createMutation.mutate({ name: name.trim(), color });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{groupId ? 'Edit Group' : 'New Group'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Group name"
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
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

        <DialogFooter className="flex-row justify-between sm:justify-between">
          {groupId && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteMutation.mutate({ id: groupId })}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!name.trim() || isPending}>
              {groupId ? 'Save' : 'Create'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
