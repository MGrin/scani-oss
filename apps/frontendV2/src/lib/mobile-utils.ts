/**
 * Mobile UX utilities and constants for better touch interactions and spacing
 */

// Mobile breakpoints and utilities
export const MOBILE_BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

// Minimum tap target sizes (following WCAG AA guidelines)
// AAA recommends 44x44px, but we use 44px as our minimum for accessibility
export const TAP_TARGETS = {
  // WCAG AA minimum touch target size
  MIN_SIZE: 44, // Recommended minimum for accessibility
  COMFORTABLE_SIZE: 48, // Comfortable touch target
  LARGE_SIZE: 56, // Large touch target for primary actions
} as const;

// Mobile-friendly spacing values
export const MOBILE_SPACING = {
  // Increased touch targets for mobile
  touchPadding: 'p-3', // 12px padding for better touch
  touchMargin: 'm-3', // 12px margin

  // Vertical spacing improvements
  sectionGap: 'space-y-4 sm:space-y-6', // 16px mobile, 24px desktop
  cardGap: 'space-y-3 sm:space-y-4', // 12px mobile, 16px desktop
  listGap: 'space-y-1 sm:space-y-1.5', // 4px mobile, 6px desktop (reduced from 8px/12px)

  // Horizontal spacing
  horizontalGap: 'space-x-2 sm:space-x-3',
  gridGap: 'gap-3 sm:gap-4 lg:gap-6',

  // Container padding
  containerPadding: 'px-4 py-4 sm:px-6 sm:py-6',
  cardPadding: 'p-4 sm:p-6',

  // Form spacing
  formFieldGap: 'space-y-4 sm:space-y-6',
  formButtonGap: 'space-y-3 sm:space-y-4',
} as const;

// Mobile-friendly component classes
export const MOBILE_CLASSES = {
  // Buttons with proper tap targets
  button: {
    primary: 'h-11 px-5 text-base touch-manipulation min-h-[44px]', // WCAG AA compliant
    secondary: 'h-10 px-3 text-sm touch-manipulation min-h-[40px]', // Comfortable size
    small: 'h-9 px-2.5 text-xs touch-manipulation min-h-[36px]', // Minimum acceptable
    icon: 'h-10 w-10 touch-manipulation', // Reduced from 48x48 to 40x40
    iconSmall: 'h-9 w-9 touch-manipulation', // Reduced from 44x44 to 36x36
  },

  // Form inputs with better touch experience
  input: {
    text: 'h-10 px-4 text-base', // Reduced from 48px to 40px
    select: 'h-10 px-4 text-base',
    textarea: 'min-h-[100px] p-4 text-base', // Reduced from 120px to 100px
  },

  // Cards and containers
  card: {
    clickable:
      'hover:shadow-md active:shadow-lg transition-shadow touch-manipulation cursor-pointer',
    padding: 'p-4 sm:p-6',
  },

  // Navigation elements
  nav: {
    item: 'h-10 px-4 flex items-center touch-manipulation', // Reduced from h-12 to h-10
    button: 'h-10 w-10 flex items-center justify-center touch-manipulation', // Reduced from h-12 w-12
  },

  // Lists with better spacing
  list: {
    item: 'py-3 px-4 touch-manipulation min-h-[44px] flex items-center',
    itemClickable:
      'py-3 px-4 hover:bg-accent active:bg-accent/80 transition-colors touch-manipulation cursor-pointer min-h-[44px] flex items-center',
  },

  // Typography responsive classes
  typography: {
    h1: 'text-2xl sm:text-3xl lg:text-4xl font-bold',
    h2: 'text-xl sm:text-2xl lg:text-3xl font-semibold',
    h3: 'text-lg sm:text-xl lg:text-2xl font-medium',
    body: 'text-sm sm:text-base',
    caption: 'text-xs sm:text-sm text-muted-foreground',
    small: 'text-xs',
  },

  // Mobile-optimized grids
  grid: {
    cards: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
    stats: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-4',
    twoColumn: 'grid gap-4 lg:grid-cols-2',
    actions: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4',
  },

  // Scrollable areas with proper padding
  scroll: {
    horizontal: 'overflow-x-auto -mx-4 px-4 pb-2',
    vertical: 'overflow-y-auto',
  },

  // Safe areas for iOS notches
  safeArea: {
    top: 'pt-safe',
    bottom: 'pb-safe',
    all: 'p-safe',
  },
} as const;

/**
 * Check if device is mobile based on screen size
 */
export function isMobileScreen(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINTS.md;
}

/**
 * Check if device is likely a touch device
 */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Get the current breakpoint
 */
export function getCurrentBreakpoint(): keyof typeof MOBILE_BREAKPOINTS | 'xs' {
  const width = window.innerWidth;

  if (width >= MOBILE_BREAKPOINTS.xl) return 'xl';
  if (width >= MOBILE_BREAKPOINTS.lg) return 'lg';
  if (width >= MOBILE_BREAKPOINTS.md) return 'md';
  if (width >= MOBILE_BREAKPOINTS.sm) return 'sm';
  return 'xs';
}

/**
 * Hook-friendly media query for mobile detection
 */
export function useMobileDetection() {
  return {
    isMobile: isMobileScreen(),
    isTouch: isTouchDevice(),
    breakpoint: getCurrentBreakpoint(),
  };
}

/**
 * Mobile UX Enhancements
 *
 * Advanced utilities for enhanced mobile user experience including
 * swipe gestures, haptic feedback, and touch interactions
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// Haptic feedback types
export type HapticType = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

/**
 * Triggers haptic feedback on supported devices
 */
export function triggerHapticFeedback(type: HapticType = 'light'): void {
  if (!('vibrate' in navigator)) return;

  // Check if running on iOS (more reliable haptic feedback)
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  if (isIOS && 'vibrate' in navigator) {
    // iOS haptic patterns
    switch (type) {
      case 'light':
        navigator.vibrate(10);
        break;
      case 'medium':
        navigator.vibrate(20);
        break;
      case 'heavy':
        navigator.vibrate(30);
        break;
      case 'success':
        navigator.vibrate([20, 10, 20]);
        break;
      case 'warning':
        navigator.vibrate([30, 10, 30, 10, 30]);
        break;
      case 'error':
        navigator.vibrate([50, 10, 50, 10, 50]);
        break;
    }
  } else {
    // Android vibration patterns
    switch (type) {
      case 'light':
        navigator.vibrate(10);
        break;
      case 'medium':
        navigator.vibrate(20);
        break;
      case 'heavy':
        navigator.vibrate(50);
        break;
      case 'success':
        navigator.vibrate([20, 10, 20]);
        break;
      case 'warning':
        navigator.vibrate([30, 10, 30, 10, 30]);
        break;
      case 'error':
        navigator.vibrate([50, 10, 50, 10, 50]);
        break;
    }
  }
}

/**
 * Hook for swipe gesture detection
 */
export interface SwipeConfig {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  threshold?: number;
  preventDefault?: boolean;
}

export function useSwipeGesture(config: SwipeConfig) {
  const elementRef = useRef<HTMLElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const isTracking = useRef(false);

  const {
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
    threshold = 50,
    preventDefault = true,
  } = config;

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!e.touches[0]) return;

    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    isTracking.current = true;
  }, []);

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isTracking.current || !e.touches[0]) return;

      if (preventDefault) {
        e.preventDefault();
      }
    },
    [preventDefault]
  );

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (!isTracking.current) return;

      isTracking.current = false;

      if (!e.changedTouches[0]) return;

      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;

      const deltaX = endX - startX.current;
      const deltaY = endY - startY.current;

      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);

      // Determine if this is a horizontal or vertical swipe
      if (absDeltaX > absDeltaY) {
        // Horizontal swipe
        if (absDeltaX > threshold) {
          if (deltaX > 0) {
            onSwipeRight?.();
            triggerHapticFeedback('light');
          } else {
            onSwipeLeft?.();
            triggerHapticFeedback('light');
          }
        }
      } else {
        // Vertical swipe
        if (absDeltaY > threshold) {
          if (deltaY > 0) {
            onSwipeDown?.();
            triggerHapticFeedback('light');
          } else {
            onSwipeUp?.();
            triggerHapticFeedback('light');
          }
        }
      }
    },
    [onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, threshold]
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    element.addEventListener('touchstart', handleTouchStart, {
      passive: !preventDefault,
    });
    element.addEventListener('touchmove', handleTouchMove, {
      passive: !preventDefault,
    });
    element.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, preventDefault]);

  return elementRef;
}

/**
 * Hook for detecting device orientation changes
 */
export function useDeviceOrientation() {
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');

  useEffect(() => {
    const updateOrientation = () => {
      const isPortrait = window.innerHeight > window.innerWidth;
      setOrientation(isPortrait ? 'portrait' : 'landscape');
    };

    updateOrientation();
    window.addEventListener('orientationchange', updateOrientation);
    window.addEventListener('resize', updateOrientation);

    return () => {
      window.removeEventListener('orientationchange', updateOrientation);
      window.removeEventListener('resize', updateOrientation);
    };
  }, []);

  return orientation;
}

/**
 * Hook for detecting if device prefers reduced motion
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

/**
 * Hook for detecting if device is in high contrast mode
 */
export function useHighContrastMode(): boolean {
  const [isHighContrast, setIsHighContrast] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-contrast: high)');
    setIsHighContrast(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsHighContrast(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isHighContrast;
}

/**
 * Enhanced mobile touch target utilities
 */
export const MOBILE_TOUCH_TARGETS = {
  MIN_SIZE: 44, // Minimum touch target size in pixels
  PREFERRED_SIZE: 48, // Preferred touch target size
  SPACING: 8, // Minimum spacing between touch targets
};

/**
 * Checks if a touch target meets accessibility guidelines
 */
export function isValidTouchTarget(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const minSize = MOBILE_TOUCH_TARGETS.MIN_SIZE;

  return rect.width >= minSize && rect.height >= minSize;
}

/**
 * Hook for managing mobile keyboard visibility
 */
export function useMobileKeyboard() {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const updateKeyboardVisibility = () => {
      // On mobile, keyboard appearance changes viewport height
      const currentHeight = window.visualViewport?.height || window.innerHeight;
      const windowHeight = window.innerHeight;
      const heightDiff = windowHeight - currentHeight;

      if (heightDiff > 150) {
        // Keyboard is likely visible
        setIsKeyboardVisible(true);
        setKeyboardHeight(heightDiff);
      } else {
        setIsKeyboardVisible(false);
        setKeyboardHeight(0);
      }
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateKeyboardVisibility);
      return () => window.visualViewport?.removeEventListener('resize', updateKeyboardVisibility);
    } else {
      // Fallback for browsers without visualViewport
      window.addEventListener('resize', updateKeyboardVisibility);
      return () => window.removeEventListener('resize', updateKeyboardVisibility);
    }
  }, []);

  return { isKeyboardVisible, keyboardHeight };
}

/**
 * Utility for smooth scrolling on mobile devices
 */
export function smoothScrollTo(element: HTMLElement, offset: number = 0): void {
  const elementTop = element.getBoundingClientRect().top + window.pageYOffset;
  const offsetPosition = elementTop - offset;

  window.scrollTo({
    top: offsetPosition,
    behavior: 'smooth',
  });
}

/**
 * Hook for managing pull-to-refresh with enhanced mobile UX
 */
export interface PullToRefreshConfig {
  onRefresh: () => Promise<void>;
  threshold?: number;
  hapticFeedback?: boolean;
  disabled?: boolean;
}

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  hapticFeedback = true,
  disabled = false,
}: PullToRefreshConfig) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startY = useRef(0);
  const isPulling = useRef(false);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (disabled || isRefreshing || !e.touches[0]) return;

      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      if (scrollTop === 0) {
        startY.current = e.touches[0].clientY;
        isPulling.current = true;
      }
    },
    [disabled, isRefreshing]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isPulling.current || isRefreshing || !e.touches[0]) return;

      const currentY = e.touches[0].clientY;
      const deltaY = currentY - startY.current;

      if (deltaY > 0) {
        e.preventDefault();
        const distance = Math.min(deltaY * 0.5, threshold * 1.5);
        setPullDistance(distance);

        // Trigger haptic feedback at threshold
        if (hapticFeedback && distance >= threshold && pullDistance < threshold) {
          triggerHapticFeedback('medium');
        }
      }
    },
    [isRefreshing, threshold, hapticFeedback, pullDistance]
  );

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling.current) return;

    isPulling.current = false;

    if (pullDistance >= threshold && !isRefreshing) {
      setIsRefreshing(true);
      try {
        await onRefresh();
        if (hapticFeedback) triggerHapticFeedback('success');
      } catch (error) {
        if (hapticFeedback) triggerHapticFeedback('error');
        console.error('Pull-to-refresh failed:', error);
      } finally {
        setIsRefreshing(false);
      }
    }

    setPullDistance(0);
  }, [pullDistance, threshold, isRefreshing, onRefresh, hapticFeedback]);

  useEffect(() => {
    if (disabled) return;

    document.addEventListener('touchstart', handleTouchStart, {
      passive: true,
    });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, disabled]);

  return {
    pullDistance,
    isRefreshing,
    progress: Math.min((pullDistance / threshold) * 100, 100),
    isTriggered: pullDistance >= threshold,
  };
}
