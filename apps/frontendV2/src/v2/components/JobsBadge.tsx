import { AlertCircle, ListChecks, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { useUserJobs } from '../hooks/useUserJobs';
import { V2_ROUTES } from '../lib/routes';

/**
 * Top-nav jobs indicator. Always rendered so users can reach `/jobs`
 * from anywhere — the previous "hide when idle" behavior broke
 * discoverability (users couldn't find their job history mid-import).
 *
 * Active state: secondary badge with spinner + count.
 * Idle state: ghost-outline list icon linking to the jobs history page.
 *
 * Wrapper is `inline-flex items-center` so the badge sits on the same
 * baseline as the sibling buttons in the `<header className="flex
 * items-center">` parent (previously the Link had no alignment rule,
 * which made the badge render ~2px above the buttons on some browsers).
 */
export function JobsBadge({ className }: { className?: string } = {}) {
  const { activeCount, actionRequiredCount } = useUserJobs();

  // Priority: action-required (amber, attention-grabbing) >
  //   in-flight (spinner, neutral) > idle (outline, calm).
  // A job that's both running AND has another action-required sibling
  // leans toward the action-required state — the pending item is the
  // one the user can actually do something about right now.
  const state: 'action' | 'active' | 'idle' =
    actionRequiredCount > 0 ? 'action' : activeCount > 0 ? 'active' : 'idle';

  const label =
    state === 'action'
      ? `${actionRequiredCount} job${actionRequiredCount > 1 ? 's' : ''} need${actionRequiredCount === 1 ? 's' : ''} your review`
      : state === 'active'
        ? `${activeCount} background task${activeCount > 1 ? 's' : ''} in progress`
        : 'Background jobs history';

  return (
    <Link
      to={V2_ROUTES.jobs}
      className={`inline-flex items-center ${className ?? ''}`}
      aria-label={label}
      title={label}
    >
      {state === 'action' ? (
        <Badge
          className="gap-1 h-7 px-2 text-xs border-amber-500/50 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300 animate-pulse-subtle"
          variant="outline"
        >
          <AlertCircle className="h-3 w-3" />
          <span>{actionRequiredCount} to review</span>
        </Badge>
      ) : state === 'active' ? (
        <Badge variant="secondary" className="gap-1 h-7 px-2 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{activeCount} running</span>
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="gap-1 h-7 px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <ListChecks className="h-3 w-3" />
          <span>Jobs</span>
        </Badge>
      )}
    </Link>
  );
}
