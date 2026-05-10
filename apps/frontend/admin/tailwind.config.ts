import sharedPreset from '@scani/ui/tailwind-preset';
import type { Config } from 'tailwindcss';

const config: Config = {
  ...sharedPreset,
  content: ['./src/**/*.{ts,tsx}', '../../../packages/frontend/ui/src/**/*.{ts,tsx}'],
};

export default config;
