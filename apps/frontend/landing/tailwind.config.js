import sharedPreset from '@scani/ui/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  ...sharedPreset,
  // Landing only consumes the design tokens (globals.css) from
  // @scani/ui — none of the JSX components — so the UI package source
  // doesn't need to be in the JIT scan.
  content: ['./index.html', './src/**/*.{ts,tsx}'],
};
