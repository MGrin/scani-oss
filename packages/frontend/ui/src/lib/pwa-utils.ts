/**
 * PWA Detection Utilities
 *
 * Functions to detect if the app is running as an installed PWA
 * and to identify the platform (iOS, Android, Desktop)
 */

export type Platform = 'ios' | 'android' | 'desktop' | 'unknown';
type DisplayMode = 'standalone' | 'minimal-ui' | 'fullscreen' | 'browser';

/**
 * Detects if the app is running as an installed PWA
 * Returns true only if app is installed AND running in standalone mode
 */
export function isPWA(): boolean {
  // SSR guard: Next.js server-renders client components, so this can run
  // with no `window`. A server is never an installed PWA.
  if (typeof window === 'undefined') return false;

  // Must be in standalone mode (not in browser tab)
  const standalone = isStandalone();

  // Check if launched from home screen (iOS specific)
  const iosStandalone =
    window.navigator && 'standalone' in window.navigator
      ? (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      : false;

  return standalone || iosStandalone;
}

/**
 * Detects if the app is running in standalone display mode
 * Note: Does NOT include fullscreen mode (which is just F11 in browser)
 */
export function isStandalone(): boolean {
  // SSR guard: no `window` on the server (see isPWA).
  if (typeof window === 'undefined') return false;

  // Check display-mode: standalone (actual PWA mode)
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }

  // Check display-mode: minimal-ui (PWA-like mode)
  if (window.matchMedia('(display-mode: minimal-ui)').matches) {
    return true;
  }

  // DO NOT check fullscreen - that's just F11 in a browser, not PWA mode
  return false;
}

/**
 * Gets the current display mode
 */
function getDisplayMode(): DisplayMode {
  if (window.matchMedia('(display-mode: fullscreen)').matches) {
    return 'fullscreen';
  }
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return 'standalone';
  }
  if (window.matchMedia('(display-mode: minimal-ui)').matches) {
    return 'minimal-ui';
  }
  return 'browser';
}

/**
 * Identifies the platform the app is running on
 */
export function getPlatform(): Platform {
  const userAgent = window.navigator.userAgent.toLowerCase();

  // Check for iOS
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return 'ios';
  }

  // Check for Android
  if (/android/.test(userAgent)) {
    return 'android';
  }

  // Check for desktop platforms
  if (/win|mac|linux/.test(userAgent)) {
    return 'desktop';
  }

  return 'unknown';
}

/**
 * Checks if the current platform supports deep linking for PWAs
 */
export function supportsDeepLinking(): boolean {
  const platform = getPlatform();
  return platform === 'ios' || platform === 'android';
}

/**
 * Gets information about the PWA state
 */
function getPWAInfo() {
  return {
    isPWA: isPWA(),
    isStandalone: isStandalone(),
    displayMode: getDisplayMode(),
    platform: getPlatform(),
    supportsDeepLinking: supportsDeepLinking(),
    userAgent: window.navigator.userAgent,
  };
}

/**
 * Logs PWA detection information for debugging.
 * Dev-only — gated to avoid noise in production browser consoles where
 * the data is irrelevant to end users and consumes Sentry breadcrumb
 * budget.
 */
export function logPWAInfo(): void {
  if (typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    console.log('PWA detection info:', getPWAInfo());
  }
}
