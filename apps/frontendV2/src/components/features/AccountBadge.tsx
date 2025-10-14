import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';

interface AccountBadgeProps {
  accountId: string;
  accountName: string;
  className?: string;
}

export function AccountBadge({ accountId, accountName, className }: AccountBadgeProps) {
  return (
    <Link to={`/accounts/${accountId}`}>
      <Badge
        variant="outline"
        className={`cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors ${
          className || ''
        }`}
      >
        {accountName}
      </Badge>
    </Link>
  );
}
