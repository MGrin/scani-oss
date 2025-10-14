import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';

interface InstitutionBadgeProps {
  institutionId: string;
  institutionName: string;
  className?: string;
}

export function InstitutionBadge({
  institutionId,
  institutionName,
  className,
}: InstitutionBadgeProps) {
  return (
    <Link to={`/institutions/${institutionId}`}>
      <Badge
        variant="outline"
        className={`cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors ${
          className || ''
        }`}
      >
        {institutionName}
      </Badge>
    </Link>
  );
}
