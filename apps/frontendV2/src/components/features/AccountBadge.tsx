import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { getAccountTypeIcon } from '@/lib/icons';

interface AccountBadgeProps {
  accountId: string;
  accountName: string;
  accountTypeCode: string;
  className?: string;
}

export function AccountBadge({
  accountId,
  accountName,
  accountTypeCode,
  className,
}: AccountBadgeProps) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/accounts/${accountId}`);
  };

  const Icon = getAccountTypeIcon(accountTypeCode);
  return (
    <Badge
      variant="outline"
      className={`px-4 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors inline-flex items-center ${
        className || ''
      }`}
      onClick={handleClick}
    >
      <Icon className="w-4 h-4 mr-2 flex-shrink-0 rounded-sm object-contain" />
      <span className="truncate">{accountName}</span>
    </Badge>
  );
}
