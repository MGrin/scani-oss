import { Skeleton } from '@scani/ui/ui/skeleton';

/**
 * Shown by Next's App Router whenever the user navigates between
 * /(authed)/* routes while the new RSC payload is streaming. Without
 * this file, clicks block the UI for as long as the slowest data
 * fetcher on the destination page takes — operators reported 10s+
 * stalls when an Upstash/Fly/Sentry call was slow. With it, the AppShell
 * stays interactive and the page area swaps to a low-fidelity skeleton
 * immediately, then the streamed content replaces the skeleton.
 *
 * The skeleton mirrors the shape every (authed) page renders:
 *   PageHeader (title + refresh indicator) → stat-card grid → section card.
 * That covers ~all pages well enough; specific routes can override with
 * their own `loading.tsx` if a different shape is worth the effort.
 */
export default function Loading() {
  return (
    <div>
      {/* PageHeader skeleton */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-2 h-3 w-80" />
        </div>
        <Skeleton className="h-7 w-24" />
      </div>

      {/* StatCard grid skeleton */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list, items never reorder
            key={i}
            className="rounded-lg border bg-card p-4"
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-24" />
            <Skeleton className="mt-1 h-3 w-32" />
          </div>
        ))}
      </div>

      {/* SectionCard skeleton */}
      <div className="mt-6 overflow-hidden rounded-lg border bg-card">
        <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-1 h-3 w-64" />
        </div>
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </div>
    </div>
  );
}
