import { ChevronRight, Home } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from './button';

interface BreadcrumbItem {
  label: string;
  href?: string;
  current?: boolean;
}

interface HierarchicalHeaderProps {
  breadcrumbs: BreadcrumbItem[];
  title: string;
  subtitle?: string;
  entityCount?: number;
  entityLabel?: string;
}

export function HierarchicalHeader({
  breadcrumbs,
  title,
  subtitle,
  entityCount,
  entityLabel,
}: HierarchicalHeaderProps) {
  return (
    <div className="space-y-2">
      {/* Breadcrumbs */}
      <nav className="flex items-center space-x-1 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground transition-colors">
          <Home className="h-4 w-4" />
        </Link>

        {breadcrumbs.map((item) => (
          <div
            key={`${item.label}-${item.href || 'current'}`}
            className="flex items-center space-x-1"
          >
            <ChevronRight className="h-3 w-3" />
            {item.current || !item.href ? (
              <span className="text-foreground font-medium">{item.label}</span>
            ) : (
              <Link to={item.href} className="hover:text-foreground transition-colors">
                {item.label}
              </Link>
            )}
          </div>
        ))}
      </nav>

      {/* Title and Count */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-1">{subtitle}</p>}
        </div>

        {entityCount !== undefined && entityLabel && (
          <div className="text-right">
            <div className="text-2xl font-bold">{entityCount}</div>
            <div className="text-sm text-muted-foreground">{entityLabel}</div>
          </div>
        )}
      </div>
    </div>
  );
}

interface NavigationActionProps {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  variant?: 'default' | 'outline' | 'secondary';
}

export function NavigationAction({
  label,
  onClick,
  icon,
  variant = 'default',
}: NavigationActionProps) {
  return (
    <Button variant={variant} onClick={onClick} className="flex items-center space-x-2">
      {icon}
      <span>{label}</span>
    </Button>
  );
}
