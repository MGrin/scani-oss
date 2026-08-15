import { formatDateTime } from '@scani/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Ban } from 'lucide-react';

/**
 * What a review looks like after the user threw it away.
 *
 * Shared by every review renderer because the alternative is worse than
 * duplication: a stamped job with no recorded outcome renders as "already
 * imported", which is a false claim about someone's portfolio for the one
 * action that deliberately wrote nothing (SC-138).
 */
export function DiscardedReviewCard({
  actionTakenAt,
  noun,
}: {
  actionTakenAt?: Date | string | null;
  noun: string;
}) {
  const when = actionTakenAt instanceof Date ? actionTakenAt : new Date(String(actionTakenAt));
  const whenLabel = actionTakenAt && !Number.isNaN(when.getTime()) ? formatDateTime(when) : '';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Ban className="h-4 w-4 text-muted-foreground" />
        <CardTitle className="text-sm">Discarded</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          This {noun} was discarded{whenLabel ? ` on ${whenLabel}` : ''}. Nothing from it was
          written to your portfolio, and it no longer waits for review. Running the import again is
          the only way to get these rows back.
        </p>
      </CardContent>
    </Card>
  );
}
