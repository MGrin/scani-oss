import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { isPWA } from '../lib/pwa-utils';

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
  disabled?: boolean;
}

export function PullToRefresh({ onRefresh, children, disabled = false }: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentY = useRef(0);
  const startScrollTop = useRef(0);

  // Only enable pull-to-refresh in PWA mode. Detected after mount, never
  // during render: this component is SSR'd in the Next.js apps where
  // `isPWA()` would touch `window` on the server. Starting `false` also
  // keeps the server and first client render identical (no hydration
  // mismatch); the effect flips it on once we know we're a real PWA.
  const [runningAsPWA, setRunningAsPWA] = useState(false);
  useEffect(() => {
    setRunningAsPWA(isPWA());
  }, []);
  const isEnabled = runningAsPWA && !disabled;

  // Minimum pull distance to start pull-to-refresh (prevents accidental triggers)
  const MIN_PULL_DISTANCE = 10;
  // Threshold to trigger refresh (in pixels)
  const PULL_THRESHOLD = 80;
  // Maximum pull distance (in pixels)
  const MAX_PULL_DISTANCE = 120;

  useEffect(() => {
    if (!isEnabled) return;

    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;

    // Find the scrollable element (could be the container itself or a child)
    const getScrollableElement = (): HTMLElement => {
      // Check if container itself is scrollable
      if (container.scrollHeight > container.clientHeight) {
        return container;
      }
      // Find the first scrollable child
      const scrollableChild = container.querySelector(
        '[data-scrollable="true"], .overflow-auto, .overflow-y-auto'
      ) as HTMLElement;
      return scrollableChild || container;
    };

    const handleTouchStart = (e: TouchEvent) => {
      const scrollableElement = getScrollableElement();
      // Only start if we're at the top of the scrollable container
      const scrollTop = scrollableElement.scrollTop;

      // Check if the touch target is within a horizontally scrollable element
      const target = e.target as HTMLElement;
      // Only check for table and overflow-x-auto (horizontal scrolling), not overflow-auto
      const isInHorizontalScroll = target.closest('table, .overflow-x-auto');

      // Don't start pull-to-refresh if touching inside a horizontally scrollable element
      if (isInHorizontalScroll) {
        return;
      }

      if (scrollTop <= 1 && !isRefreshing && e.touches[0]) {
        startY.current = e.touches[0].clientY;
        startScrollTop.current = scrollTop;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isRefreshing || !e.touches[0]) return;

      const scrollableElement = getScrollableElement();
      currentY.current = e.touches[0].clientY;
      const deltaY = currentY.current - startY.current;

      // Only pull down (positive deltaY) and only if we're still at the top
      const scrollTop = scrollableElement.scrollTop;
      if (deltaY > MIN_PULL_DISTANCE && scrollTop <= 1) {
        // Check if the touch is happening within a horizontally scrollable element
        const target = e.target as HTMLElement;
        // Only check for table and overflow-x-auto (horizontal scrolling), not overflow-auto
        const isInHorizontalScroll = target.closest('table, .overflow-x-auto');

        // Don't trigger pull-to-refresh if touching inside a horizontally scrollable element
        if (isInHorizontalScroll) {
          return;
        }

        // Start pulling if we haven't already
        if (!isPulling) {
          setIsPulling(true);
        }

        // Prevent default scrolling behavior when pulling
        e.preventDefault();

        // Apply resistance to the pull (gets harder the more you pull)
        const resistance = 0.5;
        const distance = Math.min(deltaY * resistance, MAX_PULL_DISTANCE);

        // Use RAF for smooth animation
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(() => {
          setPullDistance(distance);
        });
      } else if (isPulling && deltaY <= 0) {
        // User is scrolling up, cancel pull-to-refresh
        setIsPulling(false);
        setPullDistance(0);
      }
    };

    const handleTouchEnd = async () => {
      if (!isPulling) return;

      setIsPulling(false);

      // Trigger refresh if pulled past threshold
      if (pullDistance >= PULL_THRESHOLD && !isRefreshing) {
        setIsRefreshing(true);
        try {
          await onRefresh();
        } catch (error) {
          console.error('Pull-to-refresh error:', error);
        } finally {
          setIsRefreshing(false);
          setPullDistance(0);
        }
      } else {
        // Animate back to 0
        setPullDistance(0);
      }

      startY.current = 0;
      currentY.current = 0;
    };

    // Add touch event listeners
    container.addEventListener('touchstart', handleTouchStart, {
      passive: true,
    });
    container.addEventListener('touchmove', handleTouchMove, {
      passive: false,
    });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, {
      passive: true,
    });

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isEnabled, isPulling, isRefreshing, pullDistance, onRefresh]);

  // Calculate indicator state
  const isTriggered = pullDistance >= PULL_THRESHOLD;
  const progress = Math.min((pullDistance / PULL_THRESHOLD) * 100, 100);

  return (
    <div
      ref={containerRef}
      className={cn('relative h-full overflow-x-hidden overflow-y-auto touch-pan-y')}
    >
      {/* Pull-to-refresh indicator */}
      {isEnabled && (
        <div
          className={cn(
            'absolute left-1/2 -translate-x-1/2 z-50 transition-all duration-200 ease-out pointer-events-none',
            isPulling || isRefreshing ? 'opacity-100' : 'opacity-0'
          )}
          style={{
            top: Math.max(pullDistance - 40, 0),
            transform: `translateX(-50%) scale(${Math.min(pullDistance / PULL_THRESHOLD, 1)})`,
          }}
        >
          <div
            className={cn(
              'flex items-center justify-center w-12 h-12 rounded-full shadow-lg transition-all duration-200',
              isTriggered
                ? 'bg-primary text-primary-foreground'
                : 'bg-card border-2 border-border text-muted-foreground'
            )}
          >
            <RefreshCw
              className={cn(
                'w-5 h-5 transition-transform duration-200',
                isRefreshing ? 'animate-spin' : '',
                isTriggered && !isRefreshing ? 'rotate-180' : ''
              )}
              style={{
                transform:
                  !isRefreshing && !isTriggered ? `rotate(${progress * 3.6}deg)` : undefined,
              }}
            />
          </div>
        </div>
      )}

      {/* Content with pull offset */}
      <div
        className="transition-transform duration-200 ease-out h-full"
        style={{
          transform:
            isEnabled && (isPulling || isRefreshing)
              ? `translateY(${isRefreshing ? PULL_THRESHOLD : pullDistance}px)`
              : 'translateY(0)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
