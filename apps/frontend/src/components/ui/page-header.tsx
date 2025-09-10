import type React from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  /**
   * The main title of the page
   */
  title: string;
  /**
   * Optional subtitle or description
   */
  subtitle?: string;
  /**
   * Primary action button (usually "Add" or "Create")
   */
  primaryAction?: {
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
    disabled?: boolean;
  };
  /**
   * Secondary actions (additional buttons)
   */
  secondaryActions?: React.ReactNode;
  /**
   * Whether to show loading state
   */
  loading?: boolean;
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * Optional breadcrumb or navigation element
   */
  breadcrumb?: React.ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  primaryAction,
  secondaryActions,
  loading = false,
  className,
  breadcrumb,
}: PageHeaderProps) {
  if (loading) {
    return (
      <div className={cn('space-y-2', className)}>
        {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-8 w-48" />
            {subtitle && <Skeleton className="h-4 w-32" />}
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-muted-foreground text-lg">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {secondaryActions}
          {primaryAction && (
            <Button onClick={primaryAction.onClick} disabled={primaryAction.disabled} size="sm">
              {primaryAction.icon}
              {primaryAction.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Simplified page header for pages that only need a title
 */
export function SimplePageHeader({
  title,
  loading = false,
  className,
}: {
  title: string;
  loading?: boolean;
  className?: string;
}) {
  if (loading) {
    return (
      <div className={cn('mb-6', className)}>
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  return (
    <div className={cn('mb-6', className)}>
      <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
    </div>
  );
}
