// Scani Design System
// Centralized design tokens and utilities for consistent UI across the application

export const designSystem = {
  // Typography Scale
  typography: {
    // Font families
    fonts: {
      sans: ['Inter', 'system-ui', 'sans-serif'],
      mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      display: ['Cal Sans', 'Inter', 'system-ui', 'sans-serif'],
    },

    // Font sizes (in rem)
    sizes: {
      xs: '0.75rem', // 12px
      sm: '0.875rem', // 14px
      base: '1rem', // 16px
      lg: '1.125rem', // 18px
      xl: '1.25rem', // 20px
      '2xl': '1.5rem', // 24px
      '3xl': '1.875rem', // 30px
      '4xl': '2.25rem', // 36px
      '5xl': '3rem', // 48px
      '6xl': '3.75rem', // 60px
      '7xl': '4.5rem', // 72px
    },

    // Font weights
    weights: {
      thin: '100',
      light: '300',
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
      extrabold: '800',
      black: '900',
    },

    // Line heights
    lineHeights: {
      none: '1',
      tight: '1.25',
      snug: '1.375',
      normal: '1.5',
      relaxed: '1.625',
      loose: '2',
    },

    // Letter spacing
    letterSpacing: {
      tighter: '-0.05em',
      tight: '-0.025em',
      normal: '0',
      wide: '0.025em',
      wider: '0.05em',
      widest: '0.1em',
    },
  },

  // Spacing Scale (consistent with Tailwind CSS)
  spacing: {
    px: '1px',
    0: '0',
    0.5: '0.125rem', // 2px
    1: '0.25rem', // 4px
    1.5: '0.375rem', // 6px
    2: '0.5rem', // 8px
    2.5: '0.625rem', // 10px
    3: '0.75rem', // 12px
    3.5: '0.875rem', // 14px
    4: '1rem', // 16px
    5: '1.25rem', // 20px
    6: '1.5rem', // 24px
    7: '1.75rem', // 28px
    8: '2rem', // 32px
    9: '2.25rem', // 36px
    10: '2.5rem', // 40px
    11: '2.75rem', // 44px
    12: '3rem', // 48px
    14: '3.5rem', // 56px
    16: '4rem', // 64px
    20: '5rem', // 80px
    24: '6rem', // 96px
    28: '7rem', // 112px
    32: '8rem', // 128px
    36: '9rem', // 144px
    40: '10rem', // 160px
    44: '11rem', // 176px
    48: '12rem', // 192px
    52: '13rem', // 208px
    56: '14rem', // 224px
    60: '15rem', // 240px
    64: '16rem', // 256px
    72: '18rem', // 288px
    80: '20rem', // 320px
    96: '24rem', // 384px
  },

  // Border Radius
  borderRadius: {
    none: '0',
    sm: '0.125rem', // 2px
    default: '0.25rem', // 4px
    md: '0.375rem', // 6px
    lg: '0.5rem', // 8px
    xl: '0.75rem', // 12px
    '2xl': '1rem', // 16px
    '3xl': '1.5rem', // 24px
    full: '9999px',
  },

  // Shadows
  shadows: {
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    default: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
    none: 'none',
  },

  // Animation Durations
  animations: {
    fastest: '50ms',
    fast: '100ms',
    normal: '150ms',
    slow: '300ms',
    slower: '500ms',
    slowest: '1000ms',
  },

  // Z-Index Scale
  zIndex: {
    auto: 'auto',
    0: '0',
    10: '10',
    20: '20',
    30: '30',
    40: '40',
    50: '50',
    dropdown: '1000',
    sticky: '1020',
    fixed: '1030',
    modalBackdrop: '1040',
    modal: '1050',
    popover: '1060',
    tooltip: '1070',
    notification: '1080',
    max: '9999',
  },

  // Breakpoints (consistent with Tailwind CSS)
  breakpoints: {
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px',
  },

  // Component Specific Tokens
  components: {
    // Button specifications
    button: {
      heights: {
        sm: '2rem', // 32px
        default: '2.5rem', // 40px
        lg: '3rem', // 48px
        xl: '3.5rem', // 56px
      },
      padding: {
        sm: '0.5rem 0.75rem', // py-2 px-3
        default: '0.5rem 1rem', // py-2 px-4
        lg: '0.75rem 1.5rem', // py-3 px-6
        xl: '1rem 2rem', // py-4 px-8
      },
      fontSize: {
        sm: '0.875rem', // text-sm
        default: '1rem', // text-base
        lg: '1.125rem', // text-lg
        xl: '1.25rem', // text-xl
      },
    },

    // Input specifications
    input: {
      heights: {
        sm: '2rem', // 32px
        default: '2.5rem', // 40px
        lg: '3rem', // 48px
      },
      padding: {
        sm: '0.375rem 0.75rem', // py-1.5 px-3
        default: '0.5rem 0.75rem', // py-2 px-3
        lg: '0.75rem 1rem', // py-3 px-4
      },
      fontSize: {
        sm: '0.875rem', // text-sm
        default: '1rem', // text-base
        lg: '1.125rem', // text-lg
      },
    },

    // Card specifications
    card: {
      padding: {
        sm: '1rem', // p-4
        default: '1.5rem', // p-6
        lg: '2rem', // p-8
        xl: '3rem', // p-12
      },
      borderRadius: {
        sm: '0.25rem', // rounded
        default: '0.5rem', // rounded-lg
        lg: '0.75rem', // rounded-xl
        xl: '1rem', // rounded-2xl
      },
    },

    // Modal specifications
    modal: {
      sizes: {
        xs: '20rem', // 320px
        sm: '24rem', // 384px
        default: '32rem', // 512px
        lg: '42rem', // 672px
        xl: '48rem', // 768px
        '2xl': '56rem', // 896px
        '3xl': '64rem', // 1024px
        '4xl': '72rem', // 1152px
        '5xl': '80rem', // 1280px
        full: '100vw',
      },
    },
  },
};

// Utility functions for consistent styling

export const getSpacing = (size: keyof typeof designSystem.spacing): string => {
  return designSystem.spacing[size];
};

export const getFontSize = (size: keyof typeof designSystem.typography.sizes): string => {
  return designSystem.typography.sizes[size];
};

export const getShadow = (size: keyof typeof designSystem.shadows): string => {
  return designSystem.shadows[size];
};

export const getBorderRadius = (size: keyof typeof designSystem.borderRadius): string => {
  return designSystem.borderRadius[size];
};

// CSS-in-JS utility classes
export const cssClasses = {
  // Text utilities
  text: {
    xs: { fontSize: designSystem.typography.sizes.xs },
    sm: { fontSize: designSystem.typography.sizes.sm },
    base: { fontSize: designSystem.typography.sizes.base },
    lg: { fontSize: designSystem.typography.sizes.lg },
    xl: { fontSize: designSystem.typography.sizes.xl },
    '2xl': { fontSize: designSystem.typography.sizes['2xl'] },
    '3xl': { fontSize: designSystem.typography.sizes['3xl'] },
    '4xl': { fontSize: designSystem.typography.sizes['4xl'] },
    '5xl': { fontSize: designSystem.typography.sizes['5xl'] },
    '6xl': { fontSize: designSystem.typography.sizes['6xl'] },
    '7xl': { fontSize: designSystem.typography.sizes['7xl'] },
  },

  // Spacing utilities
  spacing: Object.fromEntries(
    Object.entries(designSystem.spacing).map(([key, value]) => [
      key,
      {
        padding: value,
        margin: value,
        gap: value,
      },
    ])
  ),

  // Shadow utilities
  shadow: Object.fromEntries(
    Object.entries(designSystem.shadows).map(([key, value]) => [key, { boxShadow: value }])
  ),
};

// Standardized message system
export const messageSystem = {
  // Success messages
  success: {
    create: {
      institution: '✅ Institution created successfully',
      account: '✅ Account created successfully',
      holding: '✅ Holding created successfully',
      transaction: '✅ Transaction created successfully',
    },
    update: {
      institution: '✅ Institution updated successfully',
      account: '✅ Account updated successfully',
      holding: '✅ Holding updated successfully',
      transaction: '✅ Transaction updated successfully',
      settings: '✅ Settings saved successfully',
      profile: '✅ Profile updated successfully',
    },
    delete: {
      institution: '✅ Institution deleted successfully',
      account: '✅ Account deleted successfully',
      holding: '✅ Holding deleted successfully',
      transaction: '✅ Transaction deleted successfully',
    },
    sync: '✅ Data synchronized successfully',
    backup: '✅ Backup created successfully',
    restore: '✅ Data restored successfully',
    import: '✅ Data imported successfully',
    export: '✅ Data exported successfully',
  },

  // Error messages
  error: {
    create: {
      institution: '❌ Failed to create institution',
      account: '❌ Failed to create account',
      holding: '❌ Failed to create holding',
      transaction: '❌ Failed to create transaction',
    },
    update: {
      institution: '❌ Failed to update institution',
      account: '❌ Failed to update account',
      holding: '❌ Failed to update holding',
      transaction: '❌ Failed to update transaction',
      settings: '❌ Failed to save settings',
      profile: '❌ Failed to update profile',
    },
    delete: {
      institution: '❌ Failed to delete institution',
      account: '❌ Failed to delete account',
      holding: '❌ Failed to delete holding',
      transaction: '❌ Failed to delete transaction',
    },
    network: '❌ Network error - please check your connection',
    server: '❌ Server error - please try again later',
    validation: '❌ Please check your input and try again',
    permission: '❌ You do not have permission to perform this action',
    notFound: '❌ The requested item was not found',
    sync: '❌ Failed to synchronize data',
    backup: '❌ Failed to create backup',
    restore: '❌ Failed to restore data',
    import: '❌ Failed to import data',
    export: '❌ Failed to export data',
  },

  // Warning messages
  warning: {
    unsavedChanges: '⚠️ You have unsaved changes',
    dataLoss: '⚠️ This action may result in data loss',
    irreversible: '⚠️ This action cannot be undone',
    duplicateName: '⚠️ An item with this name already exists',
    invalidData: '⚠️ Some data appears to be invalid',
    syncIssue: '⚠️ Data synchronization is experiencing issues',
    storageQuota: '⚠️ You are running low on storage space',
    performanceIssue: '⚠️ Performance may be affected due to large data size',
  },

  // Info messages
  info: {
    loading: 'ℹ️ Loading...',
    saving: 'ℹ️ Saving...',
    deleting: 'ℹ️ Deleting...',
    syncing: 'ℹ️ Synchronizing data...',
    noData: 'ℹ️ No data available',
    emptyState: 'ℹ️ Nothing to show here yet',
    offline: 'ℹ️ You are currently offline',
    reconnected: 'ℹ️ Connection restored',
    updating: 'ℹ️ Updating...',
    processing: 'ℹ️ Processing request...',
  },

  // Confirmation messages
  confirmation: {
    delete: {
      institution: 'Are you sure you want to delete this institution?',
      account: 'Are you sure you want to delete this account?',
      holding: 'Are you sure you want to delete this holding?',
      transaction: 'Are you sure you want to delete this transaction?',
    },
    discard: 'Are you sure you want to discard your changes?',
    reset: 'Are you sure you want to reset to default settings?',
    logout: 'Are you sure you want to log out?',
    clearData: 'Are you sure you want to clear all data?',
  },
};

// Color system with semantic naming
export const colorSystem = {
  // Semantic colors (automatically adapt to theme)
  semantic: {
    primary: 'hsl(var(--primary))',
    primaryForeground: 'hsl(var(--primary-foreground))',
    secondary: 'hsl(var(--secondary))',
    secondaryForeground: 'hsl(var(--secondary-foreground))',
    background: 'hsl(var(--background))',
    foreground: 'hsl(var(--foreground))',
    muted: 'hsl(var(--muted))',
    mutedForeground: 'hsl(var(--muted-foreground))',
    accent: 'hsl(var(--accent))',
    accentForeground: 'hsl(var(--accent-foreground))',
    destructive: 'hsl(var(--destructive))',
    destructiveForeground: 'hsl(var(--destructive-foreground))',
    border: 'hsl(var(--border))',
    input: 'hsl(var(--input))',
    ring: 'hsl(var(--ring))',
    success: 'hsl(var(--success))',
    successForeground: 'hsl(var(--success-foreground))',
    warning: 'hsl(var(--warning))',
    warningForeground: 'hsl(var(--warning-foreground))',
    info: 'hsl(var(--info))',
    infoForeground: 'hsl(var(--info-foreground))',
  },

  // Status colors
  status: {
    success: {
      bg: 'bg-green-50 dark:bg-green-950',
      text: 'text-green-700 dark:text-green-300',
      border: 'border-green-200 dark:border-green-800',
      icon: 'text-green-500',
    },
    error: {
      bg: 'bg-red-50 dark:bg-red-950',
      text: 'text-red-700 dark:text-red-300',
      border: 'border-red-200 dark:border-red-800',
      icon: 'text-red-500',
    },
    warning: {
      bg: 'bg-amber-50 dark:bg-amber-950',
      text: 'text-amber-700 dark:text-amber-300',
      border: 'border-amber-200 dark:border-amber-800',
      icon: 'text-amber-500',
    },
    info: {
      bg: 'bg-blue-50 dark:bg-blue-950',
      text: 'text-blue-700 dark:text-blue-300',
      border: 'border-blue-200 dark:border-blue-800',
      icon: 'text-blue-500',
    },
  },
};

// Layout utilities
export const layoutSystem = {
  container: {
    sm: 'max-w-screen-sm', // 640px
    md: 'max-w-screen-md', // 768px
    lg: 'max-w-screen-lg', // 1024px
    xl: 'max-w-screen-xl', // 1280px
    '2xl': 'max-w-screen-2xl', // 1536px
    full: 'max-w-full',
  },

  grid: {
    cols1: 'grid-cols-1',
    cols2: 'grid-cols-2',
    cols3: 'grid-cols-3',
    cols4: 'grid-cols-4',
    cols6: 'grid-cols-6',
    cols12: 'grid-cols-12',
  },

  gaps: {
    none: 'gap-0',
    sm: 'gap-2',
    default: 'gap-4',
    md: 'gap-6',
    lg: 'gap-8',
    xl: 'gap-12',
  },
};

// Export utility function to get design tokens
export const getDesignToken = (path: string): unknown => {
  const keys = path.split('.');
  let current: unknown = designSystem;

  for (const key of keys) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      console.warn(`Design token not found: ${path}`);
      return undefined;
    }
  }

  return current;
};

// Export CSS custom properties for theme integration
export const getCssCustomProperties = () => {
  return Object.entries(colorSystem.semantic).reduce(
    (acc, [key, value]) => {
      acc[`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`] = value;
      return acc;
    },
    {} as Record<string, string>
  );
};

export default designSystem;
