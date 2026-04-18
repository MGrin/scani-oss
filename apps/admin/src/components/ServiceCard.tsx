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
  unknown: 'bg-neutral-500',
};

export function ServiceCard({ title, href, status, statusLabel, children }: ServiceCardProps) {
  const inner = (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 h-full transition hover:border-neutral-700">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-300">{title}</h3>
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span className={`inline-block w-2 h-2 rounded-full ${dot[status]}`} />
          {statusLabel ?? status}
        </div>
      </div>
      <div className="text-sm text-neutral-200 space-y-1">{children}</div>
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
