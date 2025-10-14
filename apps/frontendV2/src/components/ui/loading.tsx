import type React from 'react';
import { cn } from '@/lib/utils';

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

interface LoadingButtonProps {
  isLoading: boolean;
  loadingText: string;
  children: React.ReactNode;
  className?: string;
}

export function LoadingButton({ isLoading, loadingText, children, className }: LoadingButtonProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {isLoading && <LoadingSpinner size="sm" className="text-current" />}
      <span>{isLoading ? loadingText : children}</span>
    </div>
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

interface ProgressIndicatorProps {
  progress: number; // 0-100
  label?: string;
  className?: string;
}

export function ProgressIndicator({ progress, label, className }: ProgressIndicatorProps) {
  return (
    <div
      className={cn('space-y-1', className)}
      role="progressbar"
      aria-valuenow={progress}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {label && <div className="text-sm font-medium">{label}</div>}
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className="bg-primary h-2 rounded-full transition-all duration-300 ease-in-out"
          style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground text-right">{Math.round(progress)}%</div>
    </div>
  );
}

interface LoadingOverlayProps {
  isVisible: boolean;
  message?: string;
  className?: string;
}

export function LoadingOverlay({
  isVisible,
  message = 'Loading...',
  className,
}: LoadingOverlayProps) {
  if (!isVisible) return null;

  return (
    <output
      className={cn(
        'absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50',
        className
      )}
    >
      <div className="flex flex-col items-center gap-3 p-4">
        <LoadingSpinner size="lg" />
        <p className="text-sm font-medium">{message}</p>
      </div>
    </output>
  );
}

// Accessibility-aware loading state that respects user preferences
interface AccessibleLoadingProps {
  isLoading: boolean;
  children: React.ReactNode;
  loadingComponent?: React.ReactNode;
}

export function AccessibleLoading({
  isLoading,
  children,
  loadingComponent,
}: AccessibleLoadingProps) {
  // Respect user's motion preferences
  const prefersReducedMotion =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  const defaultLoadingComponent = prefersReducedMotion ? (
    <div className="flex items-center gap-2 text-blue-600">
      <span className="w-2 h-2 bg-current rounded-full" aria-hidden="true" />
      <span>Loading...</span>
    </div>
  ) : (
    <div className="flex items-center gap-2 text-blue-600">
      <LoadingDots className="text-current" />
      <span>Loading...</span>
    </div>
  );

  return (
    <output aria-live="polite">
      {isLoading ? loadingComponent || defaultLoadingComponent : children}
    </output>
  );
}
