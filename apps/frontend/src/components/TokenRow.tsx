import { Edit2, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemCard } from '@/components/ui/summary-cards';
import { getTokenTypeIcon } from '@/lib/icons';

// Token type definition (matching the data from Tokens.tsx)
interface TokenData {
  id: string;
  symbol: string;
  name?: string | null;
  decimals: number;
  type?: string | null;
  typeId?: string | null;
  typeName?: string | null;
  totalBalance: string;
  totalValueInBaseCurrency: string;
  baseCurrencySymbol: string;
}

interface TokenRowProps {
  token: TokenData;
  isEditable?: boolean;
  onEdit?: (token: TokenData) => void;
  onDelete?: (token: TokenData) => void;
  onClick?: () => void;
}

export function TokenRow({ token, isEditable = false, onEdit, onDelete, onClick }: TokenRowProps) {
  const TypeIcon = getTokenTypeIcon(token.type || 'other');

  const handleEdit = () => {
    if (onEdit) onEdit(token);
  };

  const handleDelete = () => {
    if (onDelete) onDelete(token);
  };

  return (
    <ItemCard
      title={
        <div className="flex items-center space-x-2">
          <span>{`${token.symbol}${token.name ? ` - ${token.name}` : ''}`}</span>
          <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
            {token.typeName}
          </span>
        </div>
      }
      subtitle={
        <div className="space-y-1">
          <div className="flex items-center space-x-1 text-xs text-muted-foreground">
            <span>{token.decimals} decimals</span>
          </div>
        </div>
      }
      icon={TypeIcon && <TypeIcon className="h-8 w-8 text-muted-foreground" />}
      onClick={onClick}
      currencyValue={parseFloat(token.totalValueInBaseCurrency)}
      currency={token.baseCurrencySymbol}
      tokenValue={parseFloat(token.totalBalance)}
      tokenDecimals={token.decimals}
      tokenSymbol={token.symbol}
      actions={
        isEditable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEdit && (
                <DropdownMenuItem onClick={handleEdit}>
                  <Edit2 className="h-4 w-4 mr-2" />
                  Edit Token
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleDelete} className="text-destructive">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Token
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    />
  );
}
