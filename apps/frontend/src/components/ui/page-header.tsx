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
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3 -mt-1', className)}>
      {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">{title}</h1>
          {subtitle && <p className="text-muted-foreground text-sm sm:text-lg">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {secondaryActions}
          {primaryAction && (
            <Button
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              className="touch-manipulation min-h-[44px]"
              size="default"
            >
              {primaryAction.icon}
              <span className="ml-2">{primaryAction.label}</span>
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
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{title}</h1>
    </div>
  );
}
