import { formatRelative } from '@scani/shared';
import { Card } from '@scani/ui/ui/card';
import { PageLoader } from '@scani/ui/ui/loading';
import { CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useReviewFeed } from '../hooks/useReviewFeed';

/**
 * Everything waiting on the user, from every producer. Each row links to
 * the surface that owns the item; this page never mutates review state.
 */
export function ReviewPage() {
  const { items, isLoading } = useReviewFeed();

  if (isLoading) return <PageLoader />;

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-12 text-center">
        <CheckCircle2 className="text-muted-foreground h-8 w-8" />
        <p className="text-muted-foreground">Nothing needs your review.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto w-full px-0 sm:px-4 py-2 sm:py-4 flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Needs your review</h1>
      {items.map((item) => (
        <Link key={item.id} to={item.href}>
          <Card className="hover:bg-accent flex flex-col gap-1 p-4">
            <span className="font-medium">{item.title}</span>
            {item.subtitle ? (
              <span className="text-muted-foreground text-sm">{item.subtitle}</span>
            ) : null}
            <span className="text-muted-foreground text-xs">{formatRelative(item.createdAt)}</span>
          </Card>
        </Link>
      ))}
    </div>
  );
}
