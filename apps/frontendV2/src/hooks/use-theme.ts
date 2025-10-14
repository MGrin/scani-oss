import { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  isSystemTheme: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = 'scani-theme';
const THEME_ATTRIBUTE = 'data-theme';

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export function useThemeProvider() {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Try to get theme from localStorage first
    if (typeof window !== 'undefined') {
      const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
        return savedTheme as Theme;
      }
    }
    return 'system';
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    if (typeof window === 'undefined') return 'light';

    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme as ResolvedTheme;
  });

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    if (typeof window !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    }
  };

  const toggleTheme = () => {
    if (theme === 'system') {
      setTheme('light');
    } else if (theme === 'light') {
      setTheme('dark');
    } else {
      setTheme('light');
    }
  };

  // Listen for system theme changes
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        const newResolvedTheme = mediaQuery.matches ? 'dark' : 'light';
        setResolvedTheme(newResolvedTheme);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    handleChange(); // Set initial value

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  // Update resolved theme when theme changes
  useEffect(() => {
    if (theme === 'system') {
      if (typeof window !== 'undefined') {
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
        setResolvedTheme(systemTheme);
      }
    } else {
      setResolvedTheme(theme as ResolvedTheme);
    }
  }, [theme]);

  // Apply theme to document
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const root = document.documentElement;

    // Remove existing theme classes
    root.classList.remove('light', 'dark');
    root.removeAttribute(THEME_ATTRIBUTE);

    // Add new theme class and attribute
    root.classList.add(resolvedTheme);
    root.setAttribute(THEME_ATTRIBUTE, resolvedTheme);

    // Set CSS custom properties for theme
    if (resolvedTheme === 'dark') {
      root.style.colorScheme = 'dark';
    } else {
      root.style.colorScheme = 'light';
    }
  }, [resolvedTheme]);

  return {
    theme,
    resolvedTheme,
    setTheme,
    toggleTheme,
    isSystemTheme: theme === 'system',
  };
}

// Theme configuration and CSS custom properties
export const themeConfig = {
  light: {
    // Background colors
    '--background': '0 0% 100%',
    '--foreground': '222.2 84% 4.9%',
    '--card': '0 0% 100%',
    '--card-foreground': '222.2 84% 4.9%',
    '--popover': '0 0% 100%',
    '--popover-foreground': '222.2 84% 4.9%',

    // Primary colors
    '--primary': '222.2 47.4% 11.2%',
    '--primary-foreground': '210 40% 98%',

    // Secondary colors
    '--secondary': '210 40% 96%',
    '--secondary-foreground': '222.2 84% 4.9%',

    // Muted colors
    '--muted': '210 40% 96%',
    '--muted-foreground': '215.4 16.3% 46.9%',

    // Accent colors
    '--accent': '210 40% 96%',
    '--accent-foreground': '222.2 84% 4.9%',

    // Destructive colors
    '--destructive': '0 84.2% 60.2%',
    '--destructive-foreground': '210 40% 98%',

    // Border and input colors
    '--border': '214.3 31.8% 91.4%',
    '--input': '214.3 31.8% 91.4%',
    '--ring': '222.2 84% 4.9%',

    // Chart colors
    '--chart-1': '12 76% 61%',
    '--chart-2': '173 58% 39%',
    '--chart-3': '197 37% 24%',
    '--chart-4': '43 74% 66%',
    '--chart-5': '27 87% 67%',

    // Success colors
    '--success': '142.1 76.2% 36.3%',
    '--success-foreground': '355.7 100% 97.3%',

    // Warning colors
    '--warning': '32.8 95% 44.4%',
    '--warning-foreground': '210 40% 98%',

    // Info colors
    '--info': '221.2 83.2% 53.3%',
    '--info-foreground': '210 40% 98%',
  },
  dark: {
    // Background colors
    '--background': '222.2 84% 4.9%',
    '--foreground': '210 40% 98%',
    '--card': '222.2 84% 4.9%',
    '--card-foreground': '210 40% 98%',
    '--popover': '222.2 84% 4.9%',
    '--popover-foreground': '210 40% 98%',

    // Primary colors
    '--primary': '210 40% 98%',
    '--primary-foreground': '222.2 47.4% 11.2%',

    // Secondary colors
    '--secondary': '217.2 32.6% 17.5%',
    '--secondary-foreground': '210 40% 98%',

    // Muted colors
    '--muted': '217.2 32.6% 17.5%',
    '--muted-foreground': '215 20.2% 65.1%',

    // Accent colors
    '--accent': '217.2 32.6% 17.5%',
    '--accent-foreground': '210 40% 98%',

    // Destructive colors
    '--destructive': '0 62.8% 30.6%',
    '--destructive-foreground': '210 40% 98%',

    // Border and input colors
    '--border': '217.2 32.6% 17.5%',
    '--input': '217.2 32.6% 17.5%',
    '--ring': '212.7 26.8% 83.9%',

    // Chart colors
    '--chart-1': '220 70% 50%',
    '--chart-2': '160 60% 45%',
    '--chart-3': '30 80% 55%',
    '--chart-4': '280 65% 60%',
    '--chart-5': '340 75% 55%',

    // Success colors
    '--success': '142.1 70.6% 45.3%',
    '--success-foreground': '144.9 80.4% 10%',

    // Warning colors
    '--warning': '32.8 95% 44.4%',
    '--warning-foreground': '20.5 90.2% 4.3%',

    // Info colors
    '--info': '221.2 83.2% 53.3%',
    '--info-foreground': '210 40% 98%',
  },
};

// Apply theme CSS custom properties
export function applyThemeVariables(theme: ResolvedTheme) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const themeVars = themeConfig[theme];

  Object.entries(themeVars).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
}

// Theme persistence utilities
export const themeUtils = {
  save: (theme: Theme) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  },

  load: (): Theme => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved && ['light', 'dark', 'system'].includes(saved)) {
        return saved as Theme;
      }
    }
    return 'system';
  },

  remove: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    }
  },

  getSystemTheme: (): ResolvedTheme => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  },
};

// Theme-aware component utilities
export const themeClasses = {
  // Background variants
  background: {
    primary: 'bg-background text-foreground',
    secondary: 'bg-secondary text-secondary-foreground',
    muted: 'bg-muted text-muted-foreground',
    accent: 'bg-accent text-accent-foreground',
  },

  // Text variants
  text: {
    primary: 'text-foreground',
    secondary: 'text-muted-foreground',
    success: 'text-green-600 dark:text-green-400',
    warning: 'text-amber-600 dark:text-amber-400',
    error: 'text-destructive',
    info: 'text-blue-600 dark:text-blue-400',
  },

  // Border variants
  border: {
    default: 'border-border',
    muted: 'border-muted',
    accent: 'border-accent',
    destructive: 'border-destructive',
  },

  // Button variants (for consistency)
  button: {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
    destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
    ghost: 'hover:bg-accent hover:text-accent-foreground',
    link: 'text-primary underline-offset-4 hover:underline',
  },
};
