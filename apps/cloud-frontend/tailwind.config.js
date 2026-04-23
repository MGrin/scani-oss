import sharedPreset from '@scani/frontend-shared/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  ...sharedPreset,
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/frontend-shared/src/**/*.{ts,tsx}',
  ],
};
