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
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

interface AssignGroupsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'holdings' | 'accounts';
  entityIds: string[];
}

export function AssignGroupsDialog({
  open,
  onOpenChange,
  entityType,
  entityIds,
}: AssignGroupsDialogProps) {
  const utils = trpc.useUtils();
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const isHoldings = entityType === 'holdings';

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

  const holdingAssignMutation = trpc.holdings.bulkAssignGroups.useMutation({
    onSuccess: () => {
      utils.holdings.getWithDetails.invalidate();
      utils.groups.invalidate();
      showSuccess('Groups assigned');
      onOpenChange(false);
    },
    onError: (err) => showError(err, 'Assigning groups'),
  });

  const accountAssignMutation = trpc.accounts.bulkAssignGroups.useMutation({
    onSuccess: () => {
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.groups.invalidate();
      showSuccess('Groups assigned');
      onOpenChange(false);
    },
    onError: (err) => showError(err, 'Assigning groups'),
  });

  const isPending = holdingAssignMutation.isPending || accountAssignMutation.isPending;

  const handleSave = () => {
    const groupIds = Array.from(selectedGroupIds);
    if (isHoldings) {
      holdingAssignMutation.mutate({ holdingIds: entityIds, groupIds });
    } else {
      accountAssignMutation.mutate({ accountIds: entityIds, groupIds });
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
          {allGroups && allGroups.length > 0 ? (
            allGroups.map((group) => (
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
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No groups available. Create a group first.
            </p>
          )}
        </div>

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
