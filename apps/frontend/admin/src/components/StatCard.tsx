import { cn } from '@scani/ui/lib/cn';
import { Card } from '@scani/ui/ui/card';
import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Optional trend hint (e.g. "+12 today"). Rendered subtly under the value. */
  trend?: ReactNode;
  /** Lays out cards inside dense grids without extra wrappers. */
  className?: string;
}

/**
 * Single-metric tile used inside `Card` grids. Replaces the hand-rolled
 * `MetricTile`. Uses design-system tokens so a future theme switch
 * (light/dark/system) doesn't need component edits.
 */
export function StatCard({ label, value, sub, trend, className }: StatCardProps) {
  return (
    <Card className={cn('p-4', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
      {trend ? <div className="mt-1 text-xs text-emerald-500">{trend}</div> : null}
    </Card>
  );
}
