import type { ReactNode } from 'react';

interface MetricTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

export function MetricTile({ label, value, sub }: MetricTileProps) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-100">{value}</div>
      {sub ? <div className="mt-1 text-xs text-neutral-400">{sub}</div> : null}
    </div>
  );
}
