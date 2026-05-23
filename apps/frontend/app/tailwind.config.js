import sharedPreset from '@scani/ui/tailwind-preset';

/**
 * frontendV2 Tailwind config. The design tokens (colors, radii, keyframes,
 * animations) come from `@scani/ui` so cloud-frontend and this
 * app stay visually identical. Only the `content` glob is app-specific.
 */

/** @type {import('tailwindcss').Config} */
export default {
  ...sharedPreset,
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    // Include shared UI primitives so their Tailwind classes end up in the
    // final CSS bundle.
    '../../../packages/frontend/ui/src/**/*.{ts,tsx}',
  ],
};
