'use client';

import { cn } from '@scani/ui/lib/cn';
import { Button } from '@scani/ui/ui/button';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

export interface RefreshIndicatorProps {
  /** Server-stamped ISO timestamp of when this page rendered. */
  fetchedAt: string;
  className?: string;
}

/**
 * "Refreshed Xs ago" pill with a click-to-refresh button. Lives inside
 * `PageHeader` and hooks into Next's `router.refresh()` so the entire
 * Server-Component subtree re-fetches (no manual `cache: 'no-store'`
 * juggling).
 */
export function RefreshIndicator({ fetchedAt, className }: RefreshIndicatorProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState(() => formatRelative(fetchedAt));

  useEffect(() => {
    const interval = setInterval(() => setLabel(formatRelative(fetchedAt)), 5_000);
    return () => clearInterval(interval);
  }, [fetchedAt]);

  return (
    <div
      className={cn(
        'flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums',
        className
      )}
    >
      <span aria-live="polite">{pending ? 'Refreshing…' : `Refreshed ${label}`}</span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Refresh"
        className="h-7 w-7"
        disabled={pending}
        onClick={() =>
          startTransition(() => {
            router.refresh();
          })
        }
      >
        <RefreshCw className={cn('h-3.5 w-3.5', pending && 'animate-spin')} />
      </Button>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'just now';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
