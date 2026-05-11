import { cn } from '@scani/ui/lib/cn';
import { Badge } from '@scani/ui/ui/badge';

export type Status = 'ok' | 'warn' | 'error' | 'unknown';

const dotClass: Record<Status, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  unknown: 'bg-muted-foreground/40',
};

const labelDefault: Record<Status, string> = {
  ok: 'OK',
  warn: 'Warn',
  error: 'Error',
  unknown: 'Unknown',
};

export interface StatusBadgeProps {
  status: Status;
  label?: string;
  className?: string;
}

/**
 * Status pill used on every service / provider card. Wraps `Badge` so the
 * shape stays consistent with the rest of the design system; the colored
 * dot is the dense signal for operators scanning the overview.
 */
export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-mono uppercase tracking-wide', className)}>
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dotClass[status])} />
      {label ?? labelDefault[status]}
    </Badge>
  );
}
