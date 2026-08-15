import { ChevronRight, ClipboardCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { V3_ROUTES } from '../../lib/routes';

/**
 * "Is anything wrong" — the third of the three questions the home screen has
 * three seconds to answer, and the only one whose right answer is usually
 * *nothing*.
 *
 * So it renders only when there is something: the caller drops it entirely at
 * zero rather than showing an all-clear. A row that says "0 items need review"
 * is chrome the reader has to parse on every single visit to learn nothing,
 * and its presence teaches the eye to skip the place where the alarm appears.
 *
 * The count comes from `useReviewFeed`, which is where it belongs — v2 spends
 * this on an amber dot on a hamburger icon, which is the smallest possible
 * rendering of the most urgent thing on the screen.
 */

interface AttentionRowProps {
  count: number;
  className?: string;
}

export function AttentionRow({ count, className }: AttentionRowProps) {
  return (
    <Link
      to={V3_ROUTES.review}
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3',
        'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
    >
      {/* `--interactive` rather than a warning hue: the palette's first rule is
          that the accent marks what you can act on, and this row is the one
          thing on the screen that is entirely an action. Amber would also read
          as "stale price", which is a different claim. */}
      <ClipboardCheck aria-hidden="true" className="size-5 shrink-0 text-interactive" />
      <span className="min-w-0 flex-1 text-label">
        {count === 1 ? '1 item needs your review' : `${count} items need your review`}
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
