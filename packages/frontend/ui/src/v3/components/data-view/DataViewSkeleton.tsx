import { Skeleton } from '../../../ui/skeleton';

const ROWS = ['sk-a', 'sk-b', 'sk-c', 'sk-d', 'sk-e', 'sk-f'];

/**
 * A placeholder shaped like the list it is standing in for — three zones at the
 * row's real height, on the row's real hairlines. v2 rendered five identical
 * `h-12` bars in a `space-y-3` stack, which is a different layout from the one
 * that arrives, so the content visibly jumps when it does.
 *
 * The hairline is `divide-border` at full strength because that is what
 * `DataRowList` draws — a placeholder whose rules are fainter than the real
 * ones is a layout that changes twice.
 *
 * Neither the timing nor the accessibility is here, and both used to be.
 * `LoadingRamp` (V3-16) owns them: it is what decides this is drawn at all —
 * never before 1s, so a cached list cannot flash a placeholder it did not
 * need — and it is the `role="status" aria-busy` region that announces the
 * wait once. A skeleton that carries its own live region makes a screen
 * reader read six rectangles; this one is decoration inside somebody else's
 * announcement, and its whole subtree is `aria-hidden` from there.
 */
export function DataViewSkeleton() {
  return (
    <div className="divide-y divide-border">
      {ROWS.map((key) => (
        <div key={key} className="flex items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32 max-w-[60%]" />
            <Skeleton className="h-3 w-20 max-w-[40%]" />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
}
