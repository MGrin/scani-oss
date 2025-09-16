import { Edit2, Eye, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemCard } from '@/components/ui/summary-cards';
import type { ApiAccount, ApiHolding, ApiInstitution, ApiToken } from '@/lib/api-types';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { getTokenTypeIcon } from '@/lib/icons';

// Types
interface HoldingData extends ApiHolding {
  token?: ApiToken;
  account?: ApiAccount;
  institution?: ApiInstitution;
  value?: number;
}

interface HoldingRowProps {
  holding: HoldingData;
  userPrefs?: { baseCurrency?: { symbol: string } };
  showRank?: boolean;
  rank?: number;
  onView?: (holding: HoldingData) => void;
  onEdit?: (holding: HoldingData) => void;
  onDelete?: (holding: HoldingData) => void;
  onClick?: () => void;
}

export function HoldingRow({
  holding,
  userPrefs,
  showRank = false,
  rank,
  onView,
  onEdit,
  onDelete,
  onClick,
}: HoldingRowProps) {
  const TypeIcon = getTokenTypeIcon(holding.token?.type ?? '');

  const handleView = () => {
    if (onView) onView(holding);
  };

  const handleEdit = () => {
    if (onEdit) onEdit(holding);
  };

  const handleDelete = () => {
    if (onDelete) onDelete(holding);
  };

  return (
    <ItemCard
      title={
        <div className="flex items-center space-x-2">
          <span>{holding.token?.name || 'Unknown Token'}</span>
          <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
            {holding.token?.type ?? 'N/A'}
          </span>
        </div>
      }
      subtitle={
        <div className="space-y-1">
          <div className="flex items-center space-x-1 text-xs text-muted-foreground">
            {showRank && typeof rank === 'number' && (
              <>
                <span>#{rank}</span>
                <span>•</span>
              </>
            )}
            <span>{holding.account?.name || 'Unknown Account'}</span>
            {holding.institution && (
              <>
                <span>•</span>
                <span>{holding.institution.name}</span>
              </>
            )}
          </div>
        </div>
      }
      currencyValue={holding.value}
      currency={userPrefs?.baseCurrency?.symbol}
      tokenValue={parseFloat(holding.balance)}
      tokenSymbol={holding.token?.symbol}
      tokenDecimals={holding.token?.decimals}
      onClick={onClick}
      icon={TypeIcon && <TypeIcon className="h-8 w-8 text-muted-foreground" />}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onView && (
              <DropdownMenuItem onClick={handleView}>
                <Eye className="h-4 w-4 mr-2" />
                View Details
              </DropdownMenuItem>
            )}
            {onEdit && (
              <DropdownMenuItem onClick={handleEdit}>
                <Edit2 className="h-4 w-4 mr-2" />
                {BUTTON_TEXT.EDIT_HOLDING}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleDelete} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />
              {BUTTON_TEXT.DELETE_HOLDING}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
