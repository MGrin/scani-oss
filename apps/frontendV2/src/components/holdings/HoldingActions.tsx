import type { HoldingWithDetails } from '@scani/shared';
import { CheckCircle2, Edit, MoreHorizontal, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface HoldingActionsMenuProps {
  holding: HoldingWithDetails;
  onToggleActive: (holding: HoldingWithDetails) => void;
  onDelete: (holding: HoldingWithDetails) => void;
}

export function HoldingActionsMenu({ holding, onToggleActive, onDelete }: HoldingActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onToggleActive(holding);
          }}
        >
          {holding.isActive ? (
            <>
              <XCircle className="mr-2 h-4 w-4" />
              Mark as Inactive
            </>
          ) : (
            <>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Mark as Active
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onDelete(holding);
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Remove Holding
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface BulkActionBarProps {
  selectedCount: number;
  onEditSelected: () => void;
  onDeleteSelected: () => void;
  isDeletePending: boolean;
}

export function BulkActionBar({
  selectedCount,
  onEditSelected,
  onDeleteSelected,
  isDeletePending,
}: BulkActionBarProps) {
  if (selectedCount === 0) return null;
  return (
    <Card className="mb-4">
      <CardContent className="py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {selectedCount} holding
            {selectedCount !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onEditSelected}>
              <Edit className="h-4 w-4 mr-2" />
              Edit Selected
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onDeleteSelected}
              disabled={isDeletePending}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Selected
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
