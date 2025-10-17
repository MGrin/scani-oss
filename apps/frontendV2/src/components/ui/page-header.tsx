import { ArrowLeft, Plus } from 'lucide-react';
import type React from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
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
   * Back button configuration
   */
  backButton?: {
    onClick: () => void;
    label?: string;
  };
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
  backButton,
  primaryAction,
  secondaryActions,
  loading = false,
  className,
  breadcrumb,
}: PageHeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();

  // Don't show Add Data button on the Add Data page itself, dashboard, or settings
  const showAddHoldingButton =
    !location.pathname.includes('/add-data') && !location.pathname.includes('/settings');

  // Check if we're in hierarchical mode (has accountId in URL)
  const isHierarchicalMode = Boolean(params.accountId);

  const handleAddHoldingClick = () => {
    if (isHierarchicalMode && params.accountId) {
      // Navigate with pre-selected account
      navigate(`/add-data?accountId=${params.accountId}`);
    } else {
      // Navigate normally
      navigate('/add-data');
    }
  };

  if (loading) {
    return (
      <div className={cn('space-y-2', className)}>
        {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {backButton && <Skeleton className="h-8 w-8" />}
            <div className="space-y-1">
              <Skeleton className="h-8 w-48" />
              {subtitle && <Skeleton className="h-4 w-32" />}
            </div>
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
        <div className="flex items-center gap-3">
          {backButton && (
            <Button variant="ghost" size="sm" onClick={backButton.onClick} className="p-2 h-auto">
              <ArrowLeft className="h-4 w-4" />
              {backButton.label && <span className="ml-2">{backButton.label}</span>}
            </Button>
          )}
          <div className="space-y-1">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">{title}</h1>
            {subtitle && <p className="text-muted-foreground text-sm sm:text-lg">{subtitle}</p>}
          </div>
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
          {showAddHoldingButton && (
            <Button
              onClick={handleAddHoldingClick}
              className="touch-manipulation min-h-[44px] bg-primary text-primary-foreground hover:bg-primary/90"
              size="lg"
            >
              <Plus className="h-4 w-4" />
              <span className="ml-2 font-semibold">Add Data</span>
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
