import { Tags, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface HoldingBulkActionsProps {
  selectedIds: Set<string>;
  onClear: () => void;
  onDelete?: (ids: Set<string>) => void;
  onAssignGroups?: (ids: Set<string>) => void;
}

export function HoldingBulkActions({
  selectedIds,
  onClear,
  onDelete,
  onAssignGroups,
}: HoldingBulkActionsProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 shadow-lg">
      <span className="text-sm font-medium">{selectedIds.size} selected</span>
      <div className="flex items-center gap-2">
        {onAssignGroups && (
          <Button size="sm" variant="outline" onClick={() => onAssignGroups(selectedIds)}>
            <Tags className="h-3.5 w-3.5 mr-1.5" />
            Assign Groups
          </Button>
        )}
        {onDelete && (
          <Button size="sm" variant="destructive" onClick={() => onDelete(selectedIds)}>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete
          </Button>
        )}
      </div>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
