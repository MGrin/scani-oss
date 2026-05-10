import sharedPreset from '@scani/ui/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  ...sharedPreset,
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../../packages/frontend/ui/src/**/*.{ts,tsx}',
  ],
};
