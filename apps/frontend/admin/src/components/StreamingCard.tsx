import { Skeleton } from '@scani/ui/ui/skeleton';
import { type ReactNode, Suspense } from 'react';
import { SectionCard, type SectionCardProps } from './SectionCard';

export interface StreamingCardProps extends Omit<SectionCardProps, 'children'> {
  children: ReactNode;
  /** Optional explicit skeleton; defaults to a 3-line stack. */
  fallback?: ReactNode;
}

/**
 * Wraps `SectionCard` body in a `Suspense` so one slow provider doesn't
 * block the rest of the overview. The card chrome (title, description,
 * actions) renders immediately; the body streams when the awaited
 * children resolve.
 */
export function StreamingCard({ children, fallback, ...rest }: StreamingCardProps) {
  return (
    <SectionCard {...rest}>
      <Suspense fallback={fallback ?? <DefaultFallback />}>{children}</Suspense>
    </SectionCard>
  );
}

function DefaultFallback() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
