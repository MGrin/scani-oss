# PWA Features Documentation

This document outlines all Progressive Web App (PWA) features implemented in Scani.

## Overview

Scani is designed as a PWA-first application, providing a native app-like experience on mobile devices while maintaining full functionality in browsers.

## Table of Contents

- [Safe Area Support](#safe-area-support)
- [Pull-to-Refresh](#pull-to-refresh)
- [PWA Detection](#pwa-detection)
- [Authentication Flow](#authentication-flow)
- [Offline Support](#offline-support)
- [Testing](#testing)

---

## Safe Area Support

### What is Safe Area?

Safe areas are the portions of the screen that are not covered by device notches, rounded corners, status bars, or home indicators. This is particularly important for:

- **iPhone X and newer**: Notch at the top, home indicator at the bottom
- **Android devices with notches**: Various notch designs
- **Devices with rounded corners**: All modern smartphones

### Implementation

#### 1. Viewport Configuration

In `index.html`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

- `viewport-fit=cover`: Allows the app to extend into safe areas
- `black-translucent`: Makes the status bar transparent on iOS

#### 2. CSS Environment Variables

CSS provides `env()` variables for safe area insets:

- `env(safe-area-inset-top)`: Top inset (status bar, notch)
- `env(safe-area-inset-bottom)`: Bottom inset (home indicator)
- `env(safe-area-inset-left)`: Left inset (rounded corners, notch)
- `env(safe-area-inset-right)`: Right inset (rounded corners, notch)

#### 3. Utility Classes

In `index.css`, we provide utility classes:

```css
.safe-top { padding-top: env(safe-area-inset-top); }
.safe-bottom { padding-bottom: env(safe-area-inset-bottom); }
.safe-left { padding-left: env(safe-area-inset-left); }
.safe-right { padding-right: env(safe-area-inset-right); }
.safe-x { /* left + right */ }
.safe-y { /* top + bottom */ }
.safe-all { /* all sides */ }
```

#### 4. Component Implementation

**Layout.tsx** (Main App):

```tsx
// Header with top safe area
<header 
  className="flex-shrink-0 bg-card border-b safe-top"
  style={{
    paddingTop: 'max(env(safe-area-inset-top), 0px)',
  }}
>

// Main content with side and bottom safe areas
<main
  style={{
    paddingBottom: 'max(1.5rem, calc(1.5rem + env(safe-area-inset-bottom)))',
    paddingLeft: 'max(1rem, calc(1rem + env(safe-area-inset-left)))',
    paddingRight: 'max(1rem, calc(1rem + env(safe-area-inset-right)))',
  }}
>

// Sidebar with left safe area
<aside
  style={{
    paddingTop: 'env(safe-area-inset-top)',
    paddingLeft: 'env(safe-area-inset-left)',
  }}
>
```

**Auth Pages** (No Layout):

```tsx
<div 
  className="min-h-screen flex items-center justify-center"
  style={{
    paddingTop: 'max(3rem, calc(3rem + env(safe-area-inset-top)))',
    paddingBottom: 'max(3rem, calc(3rem + env(safe-area-inset-bottom)))',
    paddingLeft: 'max(1rem, calc(1rem + env(safe-area-inset-left)))',
    paddingRight: 'max(1rem, calc(1rem + env(safe-area-inset-right)))',
  }}
>
```

#### 5. Best Practices

- **Use `max()` function**: Ensure minimum padding even when safe areas are 0
- **Test on real devices**: Simulators may not accurately represent safe areas
- **Consider orientation changes**: Safe areas change in landscape mode
- **Don't rely solely on classes**: Use inline styles for dynamic values

---

## Pull-to-Refresh

### Overview

Pull-to-refresh allows users to refresh app data by pulling down on the screen, similar to native mobile apps. This feature is **only enabled in PWA mode** to avoid conflicts with browser behavior.

### Component: `PullToRefresh.tsx`

#### Features

- ✅ Touch-based gesture detection
- ✅ Visual feedback with animated icon
- ✅ Resistance-based pull (harder to pull as you go further)
- ✅ Threshold trigger (80px pull distance)
- ✅ Smooth animations with RequestAnimationFrame
- ✅ Only enabled in PWA mode
- ✅ Respects scroll position (only works when at top)

#### Visual States

1. **Idle**: No indicator visible
2. **Pulling**: Icon rotates based on pull distance, grows in size
3. **Triggered**: Icon becomes blue/primary color, rotates 180°
4. **Refreshing**: Icon spins, content stays offset

#### Implementation

```tsx
import { PullToRefresh } from '@/components/PullToRefresh';

function MyComponent() {
  const handleRefresh = async () => {
    // Refetch data
    await queryClient.invalidateQueries();
  };

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <div>Your scrollable content</div>
    </PullToRefresh>
  );
}
```

#### Configuration

In `PullToRefresh.tsx`:

```tsx
const PULL_THRESHOLD = 80;      // Distance to trigger refresh (px)
const MAX_PULL_DISTANCE = 120;  // Maximum pull distance (px)
const resistance = 0.5;         // Pull resistance factor
```

#### Layout Integration

The component is integrated into the main Layout:

```tsx
<PullToRefresh onRefresh={handleRefresh}>
  <main id={mainContentId}>
    {children}
  </main>
</PullToRefresh>
```

The `handleRefresh` function invalidates all tRPC queries:

```tsx
const handleRefresh = async () => {
  await utils.invalidate();
};
```

#### Browser Overscroll Prevention

To prevent default browser pull-to-refresh, we use:

```css
html {
  overscroll-behavior-y: none;
  overscroll-behavior: none;
}
```

This disables the browser's native "bounce" effect and pull-to-refresh.

#### Touch Event Handling

```tsx
useEffect(() => {
  const handleTouchStart = (e: TouchEvent) => {
    // Only start if at top of scroll
    if (container.scrollTop === 0 && !isRefreshing) {
      startY.current = e.touches[0].clientY;
      setIsPulling(true);
    }
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (!isPulling || isRefreshing) return;
    
    const deltaY = currentY.current - startY.current;
    if (deltaY > 0) {
      e.preventDefault(); // Prevent scrolling
      const distance = Math.min(deltaY * resistance, MAX_PULL_DISTANCE);
      setPullDistance(distance);
    }
  };

  const handleTouchEnd = async () => {
    if (pullDistance >= PULL_THRESHOLD) {
      setIsRefreshing(true);
      await onRefresh();
      setIsRefreshing(false);
    }
    setPullDistance(0);
  };
}, [/* deps */]);
```

---

## PWA Detection

### Utility: `isPWA()`

Location: `src/lib/pwa-utils.ts`

```tsx
export function isPWA(): boolean {
  // Check if running in standalone mode (iOS)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  
  // Check if running as PWA on Android/Chrome
  const isAndroidPWA = 
    window.navigator.standalone === true || 
    document.referrer.includes('android-app://');
  
  return isStandalone || isAndroidPWA;
}
```

### Usage

```tsx
import { isPWA } from '@/lib/pwa-utils';

function MyComponent() {
  const runningAsPWA = isPWA();
  
  if (runningAsPWA) {
    // Show PWA-specific UI
  } else {
    // Show browser UI
  }
}
```

### Detection Methods

1. **iOS**: `window.matchMedia('(display-mode: standalone)')`
2. **Android Chrome**: `window.navigator.standalone`
3. **Android Apps**: Check referrer for `android-app://`

---

## Authentication Flow

### Dual Flow System

Scani uses different authentication methods based on the runtime environment:

#### Browser (Desktop/Mobile Web)
- **Method**: Magic Link
- **Flow**: Email → Click link → Redirect → Authenticate
- **Template**: `magic-link.html`
- **Why**: Works seamlessly with browser redirects

#### PWA (Installed App)
- **Method**: Email OTP (6-digit code)
- **Flow**: Email → Enter code → Authenticate in-app
- **Template**: `email-otp.html`
- **Why**: No browser redirect needed, native app feel

### Implementation

```tsx
const runningAsPWA = isPWA();

if (runningAsPWA) {
  // Send OTP code
  await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true }
  });
  
  // Show code input
  <MagicCodeInput onSubmit={handleCodeSubmit} />
} else {
  // Send magic link
  await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  });
  
  // Show "check your email" message
}
```

See [SUPABASE_EMAIL_TEMPLATES.md](./SUPABASE_EMAIL_TEMPLATES.md) for email configuration.

---

## Offline Support

### Service Worker

Location: `public/sw.js`

The service worker handles:
- **Caching static assets**: HTML, CSS, JS, images
- **Offline fallback**: Show cached content when offline
- **Background sync**: Queue failed requests for later

### Manifest

Location: `public/manifest.json`

Key settings:
- `display: "standalone"`: Full-screen app mode
- `orientation: "portrait-primary"`: Lock to portrait on mobile
- `background_color`, `theme_color`: Match app branding
- `icons`: Multiple sizes for all devices (72px - 512px)

### Installation Prompt

Users can install the PWA by:
- **iOS Safari**: Share → Add to Home Screen
- **Android Chrome**: Browser menu → Install app
- **Desktop Chrome**: Address bar install icon

---

## Testing

### Testing Safe Areas

#### iOS Simulator (Xcode)
1. Open Safari in iOS Simulator
2. Navigate to app URL
3. Test on iPhone 14 Pro (has notch) or iPhone 15 Pro (Dynamic Island)
4. Add to Home Screen
5. Open installed PWA
6. Verify no overlap with status bar or home indicator

#### Android Emulator
1. Open Chrome in Android Emulator
2. Navigate to app URL
3. Install as PWA via Chrome menu
4. Open installed PWA
5. Verify safe areas on devices with notches

#### Real Device Testing
1. **iOS**: iPhone X or newer
2. **Android**: Any device with notch/cutout
3. Test in both portrait and landscape
4. Verify header, content, and navigation don't overlap with system UI

#### Chrome DevTools
1. Open DevTools
2. Toggle device toolbar (Cmd+Shift+M / Ctrl+Shift+M)
3. Select device with notch (e.g., iPhone 14 Pro)
4. Note: DevTools doesn't perfectly simulate safe areas

### Testing Pull-to-Refresh

#### Desktop Testing
- Pull-to-refresh is **disabled in browser mode**
- To test, temporarily modify `isPWA()` to return `true`

#### Mobile Testing
1. Install PWA on real device
2. Open installed app
3. Scroll to top of any page
4. Pull down on screen
5. Verify:
   - Icon appears and rotates
   - Pull feels smooth with resistance
   - Release triggers refresh
   - Data updates after refresh

#### Testing Checklist
- [ ] Pull only works when scrolled to top
- [ ] Pull doesn't work when already refreshing
- [ ] Icon rotates proportionally to pull distance
- [ ] Icon color changes when threshold reached
- [ ] Content offset animates smoothly
- [ ] Data actually refreshes
- [ ] Pull snaps back if released early
- [ ] No conflicts with browser scroll

### Testing PWA Detection

#### Browser Mode
```bash
# Open in regular browser tab
open http://localhost:5173
```
Expected: `isPWA()` returns `false`

#### PWA Mode (iOS)
1. Open Safari
2. Navigate to app
3. Tap Share button
4. Tap "Add to Home Screen"
5. Open app from home screen
6. Check console: `isPWA()` should return `true`

#### PWA Mode (Android)
1. Open Chrome
2. Navigate to app
3. Tap menu (⋮)
4. Tap "Install app" or "Add to Home screen"
5. Open app from launcher
6. Check console: `isPWA()` should return `true`

### Testing Authentication

#### Browser Flow
1. Open app in browser
2. Enter email
3. Check inbox for **magic link**
4. Click link
5. Should redirect and authenticate

#### PWA Flow
1. Open installed PWA
2. Enter email
3. Check inbox for **6-digit code**
4. Enter code in app
5. Should authenticate without leaving app

---

## Browser Compatibility

### Supported Browsers

| Browser | Version | Safe Areas | Pull-to-Refresh | PWA Support |
|---------|---------|------------|-----------------|-------------|
| iOS Safari | 11.1+ | ✅ | ✅ | ✅ |
| Chrome (Android) | 45+ | ✅ | ✅ | ✅ |
| Chrome (Desktop) | 70+ | ⚠️ N/A | ⚠️ Disabled | ✅ |
| Firefox | 79+ | ⚠️ Limited | ⚠️ Disabled | ⚠️ Limited |
| Samsung Internet | 5.0+ | ✅ | ✅ | ✅ |
| Edge (Desktop) | 79+ | ⚠️ N/A | ⚠️ Disabled | ✅ |

**Legend:**
- ✅ Full support
- ⚠️ Limited or N/A
- ❌ Not supported

### Fallback Behavior

When features aren't supported:
- **Safe areas**: Defaults to 0px (no padding added)
- **Pull-to-refresh**: Automatically disabled (no error)
- **PWA detection**: Falls back to browser mode

---

## Troubleshooting

### Safe Areas Not Working

**Symptoms**: Content overlaps with status bar or notch

**Checks:**
1. Verify `viewport-fit=cover` in `<meta>` tag
2. Check that styles use `env(safe-area-inset-*)` correctly
3. Ensure running as **installed PWA** (not browser tab)
4. Test on real device with notch/home indicator
5. Check for conflicting CSS that might override padding

**Fix:**
```css
/* ❌ Wrong - will be 0 in browser */
padding-top: env(safe-area-inset-top);

/* ✅ Right - ensures minimum padding */
padding-top: max(1rem, calc(1rem + env(safe-area-inset-top)));
```

### Pull-to-Refresh Not Working

**Symptoms**: Nothing happens when pulling down

**Checks:**
1. Verify running as **installed PWA** (check `isPWA()`)
2. Ensure you're at the **top of scroll** (scrollTop === 0)
3. Check that component isn't marked as `disabled`
4. Verify touch events are not blocked by parent elements

**Debug:**
```tsx
console.log('Is PWA?', isPWA());
console.log('Scroll position:', container.scrollTop);
console.log('Is pulling?', isPulling);
```

### PWA Not Installing

**iOS:**
- Use Safari (not Chrome, not Firefox)
- Verify manifest.json is served correctly
- Check icons are valid PNG files
- Ensure HTTPS (except localhost)

**Android:**
- Use Chrome or Samsung Internet
- Verify manifest.json is linked in HTML
- Check service worker is registered
- Ensure HTTPS (except localhost)

### Authentication Issues

**Problem**: PWA users get magic link instead of code

**Cause**: Supabase template misconfiguration

**Fix**: Verify correct template is set for Email OTP in Supabase dashboard

**Problem**: Browser users get code instead of link

**Cause**: Detection logic might be wrong

**Fix**: Check `isPWA()` implementation and `emailRedirectTo` parameter

---

## Future Enhancements

### Planned Features

- [ ] **Offline data caching**: Store portfolio data locally
- [ ] **Background sync**: Sync transactions in background
- [ ] **Push notifications**: Price alerts, portfolio updates
- [ ] **Haptic feedback**: Vibration on pull-to-refresh trigger
- [ ] **Swipe gestures**: Navigate between pages
- [ ] **Dark mode scheduling**: Auto-switch based on time
- [ ] **Biometric auth**: Face ID / Touch ID / Fingerprint
- [ ] **App shortcuts**: Quick actions from home screen

### Experimental Features

- [ ] **Web Share API**: Share portfolio snapshots
- [ ] **File System Access**: Import/export CSV files
- [ ] **Badging API**: Unread notification count on icon
- [ ] **Screen Wake Lock**: Keep screen on during price monitoring

---

## Resources

### Documentation
- [MDN: Safe Area Insets](https://developer.mozilla.org/en-US/docs/Web/CSS/env)
- [MDN: PWA](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)
- [iOS Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Material Design: Bottom Navigation](https://m3.material.io/components/navigation-bar/overview)

### Testing Tools
- [iOS Simulator](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device) (requires Xcode)
- [Android Emulator](https://developer.android.com/studio/run/emulator) (requires Android Studio)
- [BrowserStack](https://www.browserstack.com/) (real device testing)
- [Responsively App](https://responsively.app/) (multi-device preview)

### Browser Tools
- [Chrome Lighthouse](https://developers.google.com/web/tools/lighthouse) (PWA audit)
- [Safari Web Inspector](https://developer.apple.com/safari/tools/)
- [Chrome DevTools Device Mode](https://developer.chrome.com/docs/devtools/device-mode/)

---

## Summary

Scani implements comprehensive PWA features including:

✅ **Safe area support** for notched devices (iPhone X+, Android)  
✅ **Pull-to-refresh** with smooth animations (PWA-only)  
✅ **PWA detection** for runtime-specific features  
✅ **Dual authentication** (Magic Link vs OTP)  
✅ **Offline support** with service workers  
✅ **Native app feel** with standalone display mode  

All features gracefully degrade in unsupported environments.
