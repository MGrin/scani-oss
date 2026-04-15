import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';

interface AssignGroupsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'holdings' | 'accounts';
  entityIds: string[];
}

// Shared color palette for inline group creation. Mirrors the set used by
// the standalone GroupFormDialog so colors stay consistent across entry points.
const GROUP_COLORS = [
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

export function AssignGroupsDialog({
  open,
  onOpenChange,
  entityType,
  entityIds,
}: AssignGroupsDialogProps) {
  const utils = trpc.useUtils();
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const isHoldings = entityType === 'holdings';

  // Inline-create state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(GROUP_COLORS[0]!);

  const { data: allGroups } = trpc.groups.getAll.useQuery();

  const { data: holdingCommonGroups } = trpc.holdings.getCommonGroups.useQuery(
    { holdingIds: entityIds },
    { enabled: open && isHoldings && entityIds.length > 0 }
  );

  const { data: accountCommonGroups } = trpc.accounts.getCommonGroups.useQuery(
    { accountIds: entityIds },
    { enabled: open && !isHoldings && entityIds.length > 0 }
  );

  const commonGroups = isHoldings ? holdingCommonGroups : accountCommonGroups;

  // Pre-check common groups when data loads
  useEffect(() => {
    if (commonGroups) {
      setSelectedGroupIds(new Set(commonGroups.map((g) => g.id)));
    }
  }, [commonGroups]);

  // When the dialog opens with zero existing groups, auto-open the create
  // form so the user can build one in place without an extra click.
  useEffect(() => {
    if (!open) {
      setShowCreateForm(false);
      setNewGroupName('');
      setNewGroupColor(GROUP_COLORS[0]!);
      return;
    }
    if (allGroups && allGroups.length === 0) {
      setShowCreateForm(true);
    }
  }, [open, allGroups]);

  const holdingAssignMutation = trpc.holdings.bulkAssignGroups.useMutation({
    onSuccess: async () => {
      await invalidatePortfolioQueries(utils);
      showSuccess('Groups assigned');
      onOpenChange(false);
    },
    onError: (err) => showError(err, 'Assigning groups'),
  });

  const accountAssignMutation = trpc.accounts.bulkAssignGroups.useMutation({
    onSuccess: async () => {
      await invalidatePortfolioQueries(utils);
      showSuccess('Groups assigned');
      onOpenChange(false);
    },
    onError: (err) => showError(err, 'Assigning groups'),
  });

  const createGroupMutation = trpc.groups.create.useMutation({
    onSuccess: async (created) => {
      // Refetch the groups list so the new group shows up in the checkbox
      // list, then auto-select it — users almost always want the group
      // they just created to be applied to their current selection.
      await utils.groups.getAll.invalidate();
      setSelectedGroupIds((prev) => {
        const next = new Set(prev);
        next.add(created.id);
        return next;
      });
      setNewGroupName('');
      setNewGroupColor(GROUP_COLORS[0]!);
      setShowCreateForm(false);
      showSuccess(`Group "${created.name}" created`);
    },
    onError: (err) => showError(err, 'Creating group'),
  });

  const isPending =
    holdingAssignMutation.isPending ||
    accountAssignMutation.isPending ||
    createGroupMutation.isPending;

  const handleSave = () => {
    // Compute the diff between what was pre-checked (common across all
    // selected entities) and what the user now has selected. This
    // diff-based save is deliberately additive rather than REPLACE:
    // a holding that happens to have unique groups the dialog never
    // showed (because they weren't in the intersection) should keep
    // them, not lose them on save.
    const preChecked = new Set((commonGroups ?? []).map((g) => g.id));
    const addedGroupIds: string[] = [];
    const removedGroupIds: string[] = [];
    for (const id of selectedGroupIds) {
      if (!preChecked.has(id)) addedGroupIds.push(id);
    }
    for (const id of preChecked) {
      if (!selectedGroupIds.has(id)) removedGroupIds.push(id);
    }

    // If nothing actually changed, just close — avoids a pointless
    // round-trip and the cache-invalidation it would trigger.
    if (addedGroupIds.length === 0 && removedGroupIds.length === 0) {
      onOpenChange(false);
      return;
    }

    if (isHoldings) {
      holdingAssignMutation.mutate({
        holdingIds: entityIds,
        addedGroupIds,
        removedGroupIds,
      });
    } else {
      accountAssignMutation.mutate({
        accountIds: entityIds,
        addedGroupIds,
        removedGroupIds,
      });
    }
  };

  const handleCreateGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    createGroupMutation.mutate({ name, color: newGroupColor, description: null });
  };

  const toggleGroup = (groupId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const hasGroups = allGroups && allGroups.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Assign Groups to {entityIds.length} {isHoldings ? 'holding' : 'account'}
            {entityIds.length !== 1 ? 's' : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2 py-2 max-h-[300px] overflow-y-auto">
          {hasGroups
            ? allGroups.map((group) => (
                <button
                  type="button"
                  key={group.id}
                  className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-muted cursor-pointer w-full text-left"
                  onClick={() => toggleGroup(group.id)}
                >
                  <Checkbox
                    checked={selectedGroupIds.has(group.id)}
                    onCheckedChange={() => toggleGroup(group.id)}
                  />
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: group.color }}
                  />
                  <span className="text-sm">{group.name}</span>
                </button>
              ))
            : !showCreateForm && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No groups yet. Create your first one below.
                </p>
              )}
        </div>

        {showCreateForm ? (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="text-xs font-medium text-muted-foreground">New group</div>
            <div className="flex items-center gap-2">
              {GROUP_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Pick color ${color}`}
                  onClick={() => setNewGroupColor(color)}
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${
                    newGroupColor === color
                      ? 'border-foreground scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Group name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCreateGroup();
                  }
                }}
                disabled={createGroupMutation.isPending}
              />
              <Button
                size="sm"
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim() || createGroupMutation.isPending}
              >
                {createGroupMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
              {hasGroups && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewGroupName('');
                  }}
                  disabled={createGroupMutation.isPending}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setShowCreateForm(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Create new group
          </Button>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
