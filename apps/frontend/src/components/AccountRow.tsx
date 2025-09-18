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
import { useUnpriceableTokens } from '@/contexts/UnpriceableTokensContext';
import type { ApiAccount, ApiInstitution } from '@/lib/api-types';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { getAccountTypeIcon } from '@/lib/icons';

// Types
interface ProcessedAccount extends ApiAccount {
  institution?: ApiInstitution;
  balance?: number;
  holdingCount?: number;
}

interface AccountRowProps {
  account: ProcessedAccount;
  userPrefs?: { baseCurrency?: { symbol: string } };
  showInstitution?: boolean;
  onEdit?: (account: ProcessedAccount) => void;
  onDelete?: (account: ProcessedAccount) => void;
  onAddHolding?: (account: ProcessedAccount) => void;
  onClick?: () => void;
}

export function AccountRow({
  account,
  userPrefs,
  showInstitution = true,
  onEdit,
  onDelete,
  onAddHolding,
  onClick,
}: AccountRowProps) {
  const IconComponent = getAccountTypeIcon(account.type || '');
  const { isAccountAffected, shouldHighlight } = useUnpriceableTokens();

  // Check if this account contains unpriceable tokens
  const isAffected =
    shouldHighlight() &&
    account.institution?.name &&
    isAccountAffected(account.institution.name, account.name);

  const handleEdit: MouseEventHandler<HTMLDivElement> = (e) => {
    e.stopPropagation();
    if (onEdit) onEdit(account);
  };

  const handleDelete: MouseEventHandler<HTMLDivElement> = (e) => {
    e.stopPropagation();
    if (onDelete) onDelete(account);
  };

  const handleAddHolding: MouseEventHandler<HTMLDivElement> = (e) => {
    e.stopPropagation();
    if (onAddHolding) onAddHolding(account);
  };

  return (
    <ItemCard
      title={
        <div className="flex items-center space-x-2">
          <span>{account.name}</span>
          <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
            {account.type?.replace('_', ' ') ?? 'Unknown Type'}
          </span>
        </div>
      }
      subtitle={
        <div className="space-y-1">
          <div className="flex items-center space-x-1 text-xs text-muted-foreground">
            {showInstitution && account.institution && (
              <>
                <span>{account.institution.name}</span>
                <span>•</span>
              </>
            )}
            <span>{account.holdingCount ?? 0} holdings</span>
          </div>
        </div>
      }
      currencyValue={account.balance}
      currency={userPrefs?.baseCurrency?.symbol}
      icon={IconComponent && <IconComponent className="h-8 w-8 text-muted-foreground" />}
      onClick={onClick}
      isAffectedByUnpriceableTokens={!!isAffected}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onAddHolding && (
              <DropdownMenuItem onClick={handleAddHolding}>
                <Plus className="h-4 w-4 mr-2" />
                {BUTTON_TEXT.CREATE_HOLDING}
              </DropdownMenuItem>
            )}
            {onEdit && (
              <DropdownMenuItem onClick={handleEdit}>
                <Edit2 className="h-4 w-4 mr-2" />
                {BUTTON_TEXT.EDIT_ACCOUNT}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleDelete} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />
              {BUTTON_TEXT.DELETE_ACCOUNT}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
