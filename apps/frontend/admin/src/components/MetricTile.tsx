import type { ReactNode } from 'react';

interface MetricTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

export function MetricTile({ label, value, sub }: MetricTileProps) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
