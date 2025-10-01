import { useIsFetching } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

/**
 * A thin loading bar that appears at the top of the page when any queries are fetching.
 * Provides visual feedback that data is being refreshed.
 */
export function QueryLoadingIndicator() {
  const isFetching = useIsFetching();

  if (!isFetching) {
    return null;
  }

  return (
    <div className="relative h-1 w-full overflow-hidden bg-muted">
      <div className={cn('h-full bg-primary', 'animate-loading-bar')} />
    </div>
  );
}
