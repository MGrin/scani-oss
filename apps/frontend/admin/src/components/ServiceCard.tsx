import Link from 'next/link';
import type { ReactNode } from 'react';

export type ServiceStatus = 'ok' | 'warn' | 'error' | 'unknown';

interface ServiceCardProps {
  title: string;
  href?: string;
  status: ServiceStatus;
  statusLabel?: string;
  children: ReactNode;
}

const dot: Record<ServiceStatus, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  unknown: 'bg-muted-foreground',
};

export function ServiceCard({ title, href, status, statusLabel, children }: ServiceCardProps) {
  const inner = (
    <div className="rounded-lg border border-border bg-card/40 p-4 h-full transition hover:border-border">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground/80">
          {title}
        </h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={`inline-block w-2 h-2 rounded-full ${dot[status]}`} />
          {statusLabel ?? status}
        </div>
      </div>
      <div className="text-sm text-foreground space-y-1">{children}</div>
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}
