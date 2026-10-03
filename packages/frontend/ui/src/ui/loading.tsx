import { cn } from '../lib/cn';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function LoadingSpinner({ size = 'md', className }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };

  return (
    <div
      className={cn(
        'animate-spin rounded-full border-2 border-current border-t-transparent',
        sizeClasses[size],
        className
      )}
      aria-hidden="true"
    />
  );
}

interface LoadingDotsProps {
  className?: string;
  dotClassName?: string;
}

export function LoadingDots({ className, dotClassName }: LoadingDotsProps) {
  return (
    <div className={cn('flex items-center gap-1', className)} aria-hidden="true">
      <div
        className={cn('w-2 h-2 bg-current rounded-full animate-pulse', dotClassName)}
        style={{ animationDelay: '0ms' }}
      />
      <div
        className={cn('w-2 h-2 bg-current rounded-full animate-pulse', dotClassName)}
        style={{ animationDelay: '150ms' }}
      />
      <div
        className={cn('w-2 h-2 bg-current rounded-full animate-pulse', dotClassName)}
        style={{ animationDelay: '300ms' }}
      />
    </div>
  );
}
