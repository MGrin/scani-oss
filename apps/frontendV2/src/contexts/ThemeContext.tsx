import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { applyThemeVariables } from '@/hooks/use-theme';

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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize theme from localStorage or system default
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved && ['light', 'dark', 'system'].includes(saved)) {
        return saved as Theme;
      }
    }
    return 'system';
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  // Get system theme preference
  const getSystemTheme = useCallback((): ResolvedTheme => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }, []);

  // Update resolved theme based on theme and system preference
  useEffect(() => {
    const updateResolvedTheme = () => {
      if (theme === 'system') {
        setResolvedTheme(getSystemTheme());
      } else {
        setResolvedTheme(theme as ResolvedTheme);
      }
    };

    updateResolvedTheme();

    // Listen for system theme changes
    if (typeof window !== 'undefined' && theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQuery.addEventListener('change', updateResolvedTheme);
      return () => mediaQuery.removeEventListener('change', updateResolvedTheme);
    }
  }, [theme, getSystemTheme]);

  // Apply theme to DOM and save to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const root = document.documentElement;

    // Remove existing theme classes
    root.classList.remove('light', 'dark');
    root.removeAttribute(THEME_ATTRIBUTE);

    // Add new theme class and attribute
    root.classList.add(resolvedTheme);
    root.setAttribute(THEME_ATTRIBUTE, resolvedTheme);

    // Set color scheme for native form controls
    root.style.colorScheme = resolvedTheme;

    // Apply custom theme variables
    applyThemeVariables(resolvedTheme);
  }, [resolvedTheme]);

  // Save theme to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme]);

  // Theme manipulation functions
  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    if (theme === 'system') {
      setTheme('light');
    } else if (theme === 'light') {
      setTheme('dark');
    } else {
      setTheme('light');
    }
  }, [theme, setTheme]);

  // Context value
  const contextValue = useMemo<ThemeContextType>(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      toggleTheme,
      isSystemTheme: theme === 'system',
    }),
    [theme, resolvedTheme, setTheme, toggleTheme]
  );

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

// Theme loader - now just passes through since there's no loading state
export function ThemeLoader({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
