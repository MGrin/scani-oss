/**
 * Accessibility utilities for keyboard navigation, ARIA support, and user preferences
 */

import { useEffect, useState } from 'react';

// ============================================================================
// User Preferences
// ============================================================================

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function prefersHighContrast(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-contrast: high)').matches;
}

export function prefersDarkMode(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Hook to respect user motion preferences
 */
export function useReducedMotion() {
  const [prefersReduced, setPrefersReduced] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return prefersReduced;
}

/**
 * Hook to detect high contrast preference
 */
export function useHighContrast() {
  const [prefersHigh, setPrefersHigh] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-contrast: high)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-contrast: high)');
    const handler = (event: MediaQueryListEvent) => setPrefersHigh(event.matches);

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return prefersHigh;
}

// ============================================================================
// Keyboard Navigation
// ============================================================================

export const keyboardNav = {
  onEnter: (callback: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      callback();
    }
  },

  onEscape: (callback: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      callback();
    }
  },

  onArrowKeys:
    (callbacks: { up?: () => void; down?: () => void; left?: () => void; right?: () => void }) =>
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          callbacks.up?.();
          break;
        case 'ArrowDown':
          e.preventDefault();
          callbacks.down?.();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          callbacks.left?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          callbacks.right?.();
          break;
      }
    },

  onTabKey:
    (callbacks: { forward?: () => void; backward?: () => void }) => (e: React.KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          callbacks.backward?.();
        } else {
          callbacks.forward?.();
        }
      }
    },
};

// ============================================================================
// ARIA Announcements
// ============================================================================

/**
 * Announce message to screen readers (temporary element)
 */
export function announce(message: string, priority: 'polite' | 'assertive' = 'polite') {
  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', priority);
  announcement.setAttribute('aria-atomic', 'true');
  announcement.className = 'sr-only';
  announcement.textContent = message;

  document.body.appendChild(announcement);

  setTimeout(() => {
    document.body.removeChild(announcement);
  }, 1000);
}

/**
 * Announce content to screen readers (persistent live region)
 */
export function announceToScreenReader(
  message: string,
  priority: 'polite' | 'assertive' = 'polite'
) {
  if (typeof window === 'undefined') return;

  // Create or find existing live region
  let liveRegion = document.getElementById(`sr-live-${priority}`);

  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.id = `sr-live-${priority}`;
    liveRegion.setAttribute('aria-live', priority);
    liveRegion.setAttribute('aria-atomic', 'true');
    liveRegion.style.position = 'absolute';
    liveRegion.style.left = '-10000px';
    liveRegion.style.width = '1px';
    liveRegion.style.height = '1px';
    liveRegion.style.overflow = 'hidden';
    document.body.appendChild(liveRegion);
  }

  // Clear previous message and add new one
  liveRegion.textContent = '';
  // Small delay to ensure screen reader picks up the change
  setTimeout(() => {
    if (liveRegion) {
      liveRegion.textContent = message;
    }
  }, 100);
}

// ============================================================================
// Focus Management
// ============================================================================

export const focusManagement = {
  trapFocus: (element: HTMLElement) => {
    const focusableElements = element.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    element.addEventListener('keydown', handleTab);
    return () => element.removeEventListener('keydown', handleTab);
  },

  saveFocus: () => {
    const previousFocus = document.activeElement as HTMLElement;
    return () => {
      previousFocus?.focus();
    };
  },

  focusFirst: (element: HTMLElement) => {
    const focusable = element.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();
  },
};

// ============================================================================
// React Components
// ============================================================================

// Screen reader only text
export function ScreenReaderOnly({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

// Live region for dynamic content updates
export function LiveRegion({
  children,
  priority = 'polite',
}: {
  children: React.ReactNode;
  priority?: 'polite' | 'assertive';
}) {
  return (
    <output aria-live={priority} aria-atomic="true" className="sr-only">
      {children}
    </output>
  );
}
