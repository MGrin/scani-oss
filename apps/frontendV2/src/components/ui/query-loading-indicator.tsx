import { useIsFetching } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

/**
 * A thin loading bar that appears at the top of the page when any queries are fetching.
 * Provides visual feedback that data is being refreshed.
 * Uses absolute positioning to prevent layout shift.
 */
export function QueryLoadingIndicator() {
  const isFetching = useIsFetching();

  return (
    <div className="relative h-0">
      <div
        className={cn(
          'absolute top-0 left-0 right-0 h-1 w-full overflow-hidden bg-transparent transition-opacity duration-300',
          isFetching > 0 ? 'opacity-100' : 'opacity-0'
        )}
      >
        <div className="h-full w-full bg-muted/30">
          <div
            className={cn(
              'h-full bg-primary',
              isFetching > 0 && 'animate-[loading-bar_1.5s_ease-in-out_infinite]'
            )}
            style={{
              width: '40%',
              transformOrigin: 'left',
            }}
          />
        </div>
      </div>
    </div>
  );
}
