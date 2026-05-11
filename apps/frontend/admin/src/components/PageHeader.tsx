import { cn } from '@scani/ui/lib/cn';
import type { ReactNode } from 'react';
import { RefreshIndicator } from './RefreshIndicator';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Action slot — usually a button group. Stacks below the title on mobile. */
  actions?: ReactNode;
  /** ISO timestamp; when present, renders the refresh indicator. */
  fetchedAt?: string;
  className?: string;
}

/**
 * Page-level title bar. Stacks vertically on mobile, splits into
 * title-left / actions-right on `sm+`. Used as the first child of every
 * page below `AppShell` so layout stays consistent.
 */
export function PageHeader({ title, description, actions, fetchedAt, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        'mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {actions}
        {fetchedAt ? <RefreshIndicator fetchedAt={fetchedAt} /> : null}
      </div>
    </header>
  );
}
