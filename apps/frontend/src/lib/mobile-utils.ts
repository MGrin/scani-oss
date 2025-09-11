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

// Minimum tap target sizes (following WCAG AA guidelines, adjusted smaller)
export const TAP_TARGETS = {
  // Minimum recommended tap target size
  MIN_SIZE: 36, // Reduced from 44px to 36px
  COMFORTABLE_SIZE: 40, // Reduced from 48px to 40px
  LARGE_SIZE: 44, // Reduced from 56px to 44px
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
    primary: 'h-10 px-5 text-base touch-manipulation', // Reduced from 48px to 40px
    secondary: 'h-9 px-3 text-sm touch-manipulation', // Reduced from 44px to 36px
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
    item: 'py-3 px-4 touch-manipulation',
    itemClickable:
      'py-3 px-4 hover:bg-accent active:bg-accent/80 transition-colors touch-manipulation cursor-pointer',
  },

  // Modal and dialog improvements
  modal: {
    content: 'p-4 sm:p-6',
    buttons: 'space-y-3 sm:space-y-0 sm:space-x-3 sm:flex-row flex-col',
  },
} as const;

// Utility functions
export const isMobileDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MOBILE_BREAKPOINTS.md;
};

export const isTouchDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
};

// Custom hook for mobile detection
export const useMobileDetection = () => {
  if (typeof window === 'undefined') {
    return { isMobile: false, isTouch: false };
  }

  return {
    isMobile: window.innerWidth < MOBILE_BREAKPOINTS.md,
    isTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
  };
};

// Helper to combine mobile-friendly classes
export const getMobileClasses = (...classes: (string | undefined | null | false)[]): string => {
  return classes.filter(Boolean).join(' ');
};

// Generate responsive spacing classes
export const getResponsiveSpacing = (mobileSpacing: string, desktopSpacing?: string): string => {
  if (!desktopSpacing) return mobileSpacing;
  return `${mobileSpacing} sm:${desktopSpacing}`;
};

// Mobile-optimized button props
export const getMobileButtonProps = (variant: 'primary' | 'secondary' | 'icon' = 'primary') => {
  const baseProps = {
    className: MOBILE_CLASSES.button[variant],
    style: {
      minHeight: variant === 'icon' ? TAP_TARGETS.COMFORTABLE_SIZE : TAP_TARGETS.COMFORTABLE_SIZE,
      minWidth: variant === 'icon' ? TAP_TARGETS.COMFORTABLE_SIZE : 'auto',
    },
  };

  return baseProps;
};

// Mobile-optimized input props
export const getMobileInputProps = (type: 'text' | 'select' | 'textarea' = 'text') => {
  return {
    className: MOBILE_CLASSES.input[type],
    style: {
      minHeight: type === 'textarea' ? 120 : TAP_TARGETS.COMFORTABLE_SIZE,
    },
  };
};
