import { Edit2, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import type { MouseEventHandler } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemCard } from '@/components/ui/summary-cards';
import type { ApiInstitution } from '@/lib/api-types';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { getInstitutionTypeIcon } from '@/lib/icons';

// Types
interface ProcessedInstitution extends ApiInstitution {
  balance?: number;
  accountCount?: number;
}

interface InstitutionRowProps {
  institution: ProcessedInstitution;
  userPrefs?: { baseCurrency?: { symbol: string } };
  onEdit?: (institution: ProcessedInstitution) => void;
  onDelete?: (institution: ProcessedInstitution) => void;
  onAddAccount?: (institution: ProcessedInstitution) => void;
  onClick?: () => void;
}

// Helper function to get institution type label
function getInstitutionTypeLabel(type: string): string {
  if (!type) return 'N/A';
  return type.replace(/_/g, ' ');
}

export function InstitutionRow({
  institution,
  userPrefs,
  onEdit,
  onDelete,
  onAddAccount,
  onClick,
}: InstitutionRowProps) {
  const IconComponent = getInstitutionTypeIcon(institution.type || '');

  const handleEdit: MouseEventHandler<HTMLDivElement> = (e) => {
    e.stopPropagation();
    if (onEdit) onEdit(institution);
  };

  const handleDelete: MouseEventHandler<HTMLDivElement> = (e) => {
    e.stopPropagation();
    if (onDelete) onDelete(institution);
  };

  const handleAddAccount: MouseEventHandler<HTMLDivElement> = (e) => {
    e.stopPropagation();
    if (onAddAccount) onAddAccount(institution);
  };

  return (
    <ItemCard
      title={
        <div className="flex items-center space-x-2">
          <span>{institution.name}</span>
          <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
            {getInstitutionTypeLabel(institution.type ?? '')}
          </span>
        </div>
      }
      subtitle={
        <div className="space-y-1">
          <div className="flex items-center space-x-1 text-xs text-muted-foreground">
            <span>{institution.accountCount ?? 0} accounts</span>
            <span>•</span>
            <span>Added {new Date(institution.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="text-xs text-muted-foreground min-h-[1rem]">
            {institution.description || ''}
          </div>
        </div>
      }
      icon={
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <IconComponent className="h-6 w-6 text-primary" />
        </div>
      }
      onClick={onClick}
      currencyValue={institution.balance}
      currency={userPrefs?.baseCurrency?.symbol}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onAddAccount && (
              <DropdownMenuItem onClick={handleAddAccount}>
                <Plus className="h-4 w-4 mr-2" />
                {BUTTON_TEXT.CREATE_ACCOUNT}
              </DropdownMenuItem>
            )}
            {onEdit && (
              <DropdownMenuItem onClick={handleEdit}>
                <Edit2 className="h-4 w-4 mr-2" />
                {BUTTON_TEXT.EDIT_INSTITUTION}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleDelete} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />
              {BUTTON_TEXT.DELETE_INSTITUTION}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
