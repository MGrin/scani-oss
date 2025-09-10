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
export const TAP_TARGETS = {
  // Minimum recommended tap target size
  MIN_SIZE: 44, // 44px x 44px minimum
  COMFORTABLE_SIZE: 48, // 48px x 48px for better UX
  LARGE_SIZE: 56, // 56px x 56px for primary actions
} as const;

// Mobile-friendly spacing values
export const MOBILE_SPACING = {
  // Increased touch targets for mobile
  touchPadding: 'p-3', // 12px padding for better touch
  touchMargin: 'm-3', // 12px margin

  // Vertical spacing improvements
  sectionGap: 'space-y-4 sm:space-y-6', // 16px mobile, 24px desktop
  cardGap: 'space-y-3 sm:space-y-4', // 12px mobile, 16px desktop
  listGap: 'space-y-2 sm:space-y-3', // 8px mobile, 12px desktop

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
    primary: 'h-12 px-6 text-base touch-manipulation', // 48px height
    secondary: 'h-11 px-4 text-sm touch-manipulation', // 44px height
    icon: 'h-12 w-12 touch-manipulation', // 48x48 for icon buttons
    iconSmall: 'h-11 w-11 touch-manipulation', // 44x44 for smaller icons
  },

  // Form inputs with better touch experience
  input: {
    text: 'h-12 px-4 text-base', // 48px height for easy tapping
    select: 'h-12 px-4 text-base',
    textarea: 'min-h-[120px] p-4 text-base',
  },

  // Cards and containers
  card: {
    clickable:
      'hover:shadow-md active:shadow-lg transition-shadow touch-manipulation cursor-pointer',
    padding: 'p-4 sm:p-6',
  },

  // Navigation elements
  nav: {
    item: 'h-12 px-4 flex items-center touch-manipulation',
    button: 'h-12 w-12 flex items-center justify-center touch-manipulation',
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
