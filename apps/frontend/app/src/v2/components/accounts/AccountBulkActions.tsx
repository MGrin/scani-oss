import { Button } from '@scani/ui/ui/button';
import { Tags, Trash2 } from 'lucide-react';

interface AccountBulkActionsProps {
  selectedIds: Set<string>;
  onClear: () => void;
  onDelete?: (ids: Set<string>) => void;
  onAssignGroups?: (ids: Set<string>) => void;
}

export function AccountBulkActions({
  selectedIds,
  onClear,
  onDelete,
  onAssignGroups,
}: AccountBulkActionsProps) {
  return (
    <>
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
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </>
  );
}
