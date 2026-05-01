import { Button } from '@scani/ui/ui/button';
import { Checkbox } from '@scani/ui/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scani/ui/ui/dialog';
import { Input } from '@scani/ui/ui/input';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
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

  // Inline-create form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(GROUP_COLORS[0]!);

  const { data: allGroups } = trpc.groups.getAll.useQuery();
  const hasGroups = allGroups !== undefined && allGroups.length > 0;

  // Guard the common-groups queries on both `open` and a non-empty
  // selection. The backend now tolerates empty arrays too (see router
  // changes in this commit), but skipping the call avoids a pointless
  // round-trip when the dialog is transiently mounted with `[]`.
  const { data: holdingCommonGroups } = trpc.holdings.getCommonGroups.useQuery(
    { holdingIds: entityIds },
    { enabled: open && isHoldings && entityIds.length > 0 }
  );

  const { data: accountCommonGroups } = trpc.accounts.getCommonGroups.useQuery(
    { accountIds: entityIds },
    { enabled: open && !isHoldings && entityIds.length > 0 }
  );

  const commonGroups = isHoldings ? holdingCommonGroups : accountCommonGroups;

  // Pre-check common groups when data loads.
  useEffect(() => {
    if (commonGroups) {
      setSelectedGroupIds(new Set(commonGroups.map((g) => g.id)));
    }
  }, [commonGroups]);

  // Reset the create-form UI whenever the dialog is closed so re-opening
  // it doesn't flash stale form state.
  useEffect(() => {
    if (!open) {
      setShowCreateForm(false);
      setNewGroupName('');
      setNewGroupColor(GROUP_COLORS[0]!);
    }
  }, [open]);

  const holdingAssignMutation = trpc.holdings.bulkAssignGroups.useMutation({
    onError: (err) => showError(err, 'Assigning groups'),
  });

  const accountAssignMutation = trpc.accounts.bulkAssignGroups.useMutation({
    onError: (err) => showError(err, 'Assigning groups'),
  });

  const createGroupMutation = trpc.groups.create.useMutation({
    onError: (err) => showError(err, 'Creating group'),
  });

  const isPending =
    holdingAssignMutation.isPending ||
    accountAssignMutation.isPending ||
    createGroupMutation.isPending;

  /**
   * Apply a set of add/remove group diffs to the current selection of
   * entities. Shared by the normal Save button and the empty-state
   * "Create & Assign" shortcut.
   */
  const applyGroupDiff = async (addedGroupIds: string[], removedGroupIds: string[]) => {
    if (addedGroupIds.length === 0 && removedGroupIds.length === 0) return;
    if (isHoldings) {
      await holdingAssignMutation.mutateAsync({
        holdingIds: entityIds,
        addedGroupIds,
        removedGroupIds,
      });
    } else {
      await accountAssignMutation.mutateAsync({
        accountIds: entityIds,
        addedGroupIds,
        removedGroupIds,
      });
    }
  };

  const handleSave = async () => {
    // Compute the diff between what was pre-checked (common across all
    // selected entities) and what the user now has selected. Diff-based
    // save is deliberately additive, not REPLACE: a holding that has
    // unique groups the dialog never showed (because they weren't in
    // the intersection) should keep them, not lose them on save.
    const preChecked = new Set((commonGroups ?? []).map((g) => g.id));
    const addedGroupIds: string[] = [];
    const removedGroupIds: string[] = [];
    for (const id of selectedGroupIds) {
      if (!preChecked.has(id)) addedGroupIds.push(id);
    }
    for (const id of preChecked) {
      if (!selectedGroupIds.has(id)) removedGroupIds.push(id);
    }

    if (addedGroupIds.length === 0 && removedGroupIds.length === 0) {
      onOpenChange(false);
      return;
    }

    try {
      await applyGroupDiff(addedGroupIds, removedGroupIds);
      // Close + toast immediately; invalidate in the background so the
      // dialog doesn't block on every portfolio query refetching.
      showSuccess('Groups assigned');
      onOpenChange(false);
      void invalidatePortfolioQueries(utils);
    } catch {
      // onError toast already fired
    }
  };

  /**
   * Empty-state flow: create a new group AND immediately apply it to
   * the selection in a single click. No separate Save step — the user's
   * intent is clear.
   */
  const handleCreateAndAssign = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      const created = await createGroupMutation.mutateAsync({
        name,
        color: newGroupColor,
        description: null,
      });
      await utils.groups.getAll.invalidate();
      await applyGroupDiff([created.id], []);
      showSuccess(`Group "${created.name}" created and assigned`);
      onOpenChange(false);
      void invalidatePortfolioQueries(utils);
    } catch {
      // onError toasts already fired
    }
  };

  /**
   * Standard-state flow: create a new group and add it to the dialog's
   * current selection. The user may want to pick more groups too, so we
   * keep the dialog open and let them Save when they're done.
   */
  const handleCreateAndAdd = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      const created = await createGroupMutation.mutateAsync({
        name,
        color: newGroupColor,
        description: null,
      });
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
    } catch {
      // onError toast already fired
    }
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

  const entityLabel = isHoldings ? 'holding' : 'account';
  const entityLabelPlural = isHoldings ? 'holdings' : 'accounts';
  const entityCountLabel = `${entityIds.length} ${
    entityIds.length === 1 ? entityLabel : entityLabelPlural
  }`;

  // === Empty-state branch: no groups exist yet ===
  //
  // Render a focused "create your first group" flow instead of an
  // empty checkbox list with a disconnected form below it. One action,
  // one button, one click.
  if (open && allGroups !== undefined && !hasGroups) {
    const canCreate = newGroupName.trim().length > 0 && !isPending;
    return (
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (isPending) return;
          onOpenChange(v);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign a group to {entityCountLabel}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <p className="text-sm text-muted-foreground">
              You don't have any groups yet. Create your first one and we'll assign it to the
              selected {entityLabelPlural}.
            </p>

            <div className="space-y-3">
              <ColorPicker value={newGroupColor} onChange={setNewGroupColor} />
              <Input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Group name"
                className="h-9"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) {
                    e.preventDefault();
                    void handleCreateAndAssign();
                  }
                }}
                disabled={isPending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreateAndAssign()} disabled={!canCreate}>
              {isPending ? 'Creating...' : 'Create & Assign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // === Standard branch: at least one group exists ===
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign groups to {entityCountLabel}</DialogTitle>
        </DialogHeader>

        <div className="space-y-0.5 max-h-[280px] overflow-y-auto -mx-1 px-1">
          {(allGroups ?? []).map((group) => {
            const checked = selectedGroupIds.has(group.id);
            return (
              <button
                type="button"
                key={group.id}
                className={cn(
                  'flex items-center gap-3 rounded-md px-2 py-2 w-full text-left transition-colors',
                  'hover:bg-muted/60',
                  checked && 'bg-muted/30',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
                onClick={() => toggleGroup(group.id)}
                disabled={isPending}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleGroup(group.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: group.color }}
                />
                <span className="text-sm">{group.name}</span>
              </button>
            );
          })}
        </div>

        {showCreateForm ? (
          <div className="space-y-2.5 border-t pt-3">
            <ColorPicker value={newGroupColor} onChange={setNewGroupColor} />
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Group name"
                className="h-9"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newGroupName.trim()) {
                    e.preventDefault();
                    void handleCreateAndAdd();
                  }
                }}
                disabled={createGroupMutation.isPending}
              />
              <Button
                size="sm"
                onClick={() => void handleCreateAndAdd()}
                disabled={!newGroupName.trim() || createGroupMutation.isPending}
              >
                {createGroupMutation.isPending ? 'Adding...' : 'Add'}
              </Button>
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
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            disabled={isPending}
            className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors border-t pt-3 w-full disabled:opacity-50 disabled:pointer-events-none"
          >
            <Plus className="h-3.5 w-3.5" />
            Create new group
          </button>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={isPending}>
            {isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compact color picker used by both the empty-state and the
 * "+ Create new group" inline form. Selected swatch gets a subtle ring
 * rather than a heavy border + scale — swatches stay a consistent size
 * regardless of selection state, which keeps the layout calm.
 */
function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {GROUP_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Pick color ${color}`}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
          className={cn(
            'h-5 w-5 rounded-full transition-all',
            value === color
              ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground'
              : 'opacity-70 hover:opacity-100 hover:scale-110'
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}
