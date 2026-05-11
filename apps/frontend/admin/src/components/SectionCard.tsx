import { cn } from '@scani/ui/lib/cn';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import type { ReactNode } from 'react';

export interface SectionCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Action slot (e.g. status badge, button group). */
  actions?: ReactNode;
  children: ReactNode;
  /** Skips the inner content padding so the children can place their own table / list flush. */
  flushBody?: boolean;
  className?: string;
}

/**
 * Replaces the hand-rolled `Section`. Thin wrapper around `Card` so every
 * page composes the same shell: title (+ optional description, actions)
 * over a content body. Use `flushBody` for tables — `CardContent`'s
 * default padding clashes with full-width data grids.
 */
export function SectionCard({
  title,
  description,
  actions,
  children,
  flushBody,
  className,
}: SectionCardProps) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 border-b border-border/60 bg-muted/20 px-4 py-3">
        <div className="min-w-0">
          <CardTitle className="text-sm font-semibold tracking-tight">{title}</CardTitle>
          {description ? (
            <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
          ) : null}
        </div>
        {actions ? <div className="flex flex-shrink-0 items-center gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent className={cn(flushBody ? 'p-0' : 'p-4')}>{children}</CardContent>
    </Card>
  );
}
