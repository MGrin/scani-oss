import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MultiSelect } from '@/components/ui/multi-select';
import { trpc } from '@/lib/trpc';

interface BulkEditGroupsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'account' | 'holding';
  selectedEntityIds: string[];
  onSuccess?: () => void;
}

export function BulkEditGroupsModal({
  open,
  onOpenChange,
  entityType,
  selectedEntityIds,
  onSuccess,
}: BulkEditGroupsModalProps) {
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);

  // Fetch all available groups
  const { data: groups } = trpc.groups.getAll.useQuery();

  // Fetch common groups based on entity type
  const accountsCommonGroupsQuery = trpc.accounts.getCommonGroups.useQuery(
    { accountIds: selectedEntityIds },
    {
      enabled: open && entityType === 'account' && selectedEntityIds.length > 0,
    }
  );

  const holdingsCommonGroupsQuery = trpc.holdings.getCommonGroups.useQuery(
    { holdingIds: selectedEntityIds },
    {
      enabled: open && entityType === 'holding' && selectedEntityIds.length > 0,
    }
  );

  const fetchedCommonGroupIds =
    entityType === 'account'
      ? (accountsCommonGroupsQuery.data ?? [])
      : (holdingsCommonGroupsQuery.data ?? []);

  // Initialize selected groups with common groups
  useEffect(() => {
    if (open && fetchedCommonGroupIds.length > 0) {
      setSelectedGroups(fetchedCommonGroupIds.map((g) => g.id));
    }
  }, [open, fetchedCommonGroupIds]);

  // Bulk assign mutations
  const bulkAssignAccountGroupsMutation = trpc.accounts.bulkAssignGroups.useMutation({
    onSuccess: () => {
      onSuccess?.();
      onOpenChange(false);
    },
  });

  const bulkAssignHoldingGroupsMutation = trpc.holdings.bulkAssignGroups.useMutation({
    onSuccess: () => {
      onSuccess?.();
      onOpenChange(false);
    },
  });

  const handleSave = () => {
    if (entityType === 'account') {
      bulkAssignAccountGroupsMutation.mutate({
        accountIds: selectedEntityIds,
        groupIds: selectedGroups,
      });
    } else {
      bulkAssignHoldingGroupsMutation.mutate({
        holdingIds: selectedEntityIds,
        groupIds: selectedGroups,
      });
    }
  };

  const isSaving =
    entityType === 'account'
      ? bulkAssignAccountGroupsMutation.isPending
      : bulkAssignHoldingGroupsMutation.isPending;

  const multiSelectItems =
    groups?.map((group) => ({
      value: group.id,
      label: group.name,
      color: group.color,
    })) || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Groups</DialogTitle>
          <DialogDescription>
            Assign or remove groups from {selectedEntityIds.length} selected {entityType}
            {selectedEntityIds.length !== 1 ? 's' : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!groups || groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No groups available. Create a group first.
            </p>
          ) : (
            <MultiSelect
              selected={selectedGroups}
              onSelectedChange={setSelectedGroups}
              placeholder="Select groups..."
              searchPlaceholder="Search groups..."
              emptyMessage="No groups found."
              items={multiSelectItems}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !groups || groups.length === 0}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
