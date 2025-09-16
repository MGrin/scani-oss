import { Edit2, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemCard } from '@/components/ui/summary-cards';
import type { ApiAccount, ApiToken } from '@/lib/api-types';

// Types
type Transaction = {
  id: string;
  holdingId: string;
  type: string;
  amount: string;
  baseCurrencyAmount: string;
  baseCurrencySymbol: string;
  fee: string;
  timestamp: string;
  createdAt: string;
  updatedAt: string;
  description?: string | null;
  reference?: string | null;
  feeTokenId?: string | null;
};

interface TransactionRowProps {
  transaction: Transaction;
  account?: ApiAccount;
  token?: ApiToken;
  onEdit?: (transaction: Transaction) => void;
  onDelete?: (transaction: Transaction) => void;
  getTransactionColor: (type: string) => string;
  getTransactionIcon: (type: string) => React.ReactNode;
}

export function TransactionRow({
  transaction,
  account,
  token,
  onEdit,
  onDelete,
  getTransactionColor,
  getTransactionIcon,
}: TransactionRowProps) {
  const handleEdit = () => {
    if (onEdit) onEdit(transaction);
  };

  const handleDelete = () => {
    if (onDelete) onDelete(transaction);
  };

  return (
    <ItemCard
      title={
        <div className="flex items-center space-x-2">
          <span>
            {transaction.description ||
              `${transaction.type.charAt(0).toUpperCase() + transaction.type.slice(1)} transaction`}
          </span>
          <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
            {transaction.type}
          </span>
        </div>
      }
      subtitle={
        <div className="space-y-1">
          <div className="flex items-center space-x-1 text-xs text-muted-foreground">
            <span>{new Date(transaction.timestamp).toLocaleDateString()}</span>
            <span>•</span>
            <span>{account?.name || 'Unknown Account'}</span>
            {token && (
              <>
                <span>•</span>
                <span>{token.symbol}</span>
              </>
            )}
          </div>
        </div>
      }
      icon={
        <div
          className={`h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold ${getTransactionColor(
            transaction.type
          )}`}
        >
          {getTransactionIcon(transaction.type)}
        </div>
      }
      currencyValue={parseFloat(transaction.baseCurrencyAmount)}
      currency={transaction.baseCurrencySymbol}
      tokenValue={parseFloat(transaction.amount)}
      tokenSymbol={token?.symbol}
      tokenDecimals={token?.decimals}
      actions={
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
                Edit Transaction
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleDelete} className="text-destructive">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Transaction
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}
