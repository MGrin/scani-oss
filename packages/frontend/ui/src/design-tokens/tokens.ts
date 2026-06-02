export interface TokenValue {
  light: string;
  dark: string;
}

// Source of truth for Scani's color tokens, as CSS HSL triples ("H S% L%").
// Kept identical to packages/frontend/ui/src/styles/globals.css by the
// tokens-consistency test; the native themes are generated from here.
export const COLOR_TOKENS: Record<string, TokenValue> = {
  background: { light: '0 0% 100%', dark: '0 0% 3.9%' },
  foreground: { light: '0 0% 3.9%', dark: '0 0% 98%' },
  card: { light: '0 0% 100%', dark: '0 0% 3.9%' },
  'card-foreground': { light: '0 0% 3.9%', dark: '0 0% 98%' },
  popover: { light: '0 0% 100%', dark: '0 0% 3.9%' },
  'popover-foreground': { light: '0 0% 3.9%', dark: '0 0% 98%' },
  primary: { light: '0 0% 9%', dark: '0 0% 98%' },
  'primary-foreground': { light: '0 0% 98%', dark: '0 0% 9%' },
  secondary: { light: '0 0% 96.1%', dark: '0 0% 14.9%' },
  'secondary-foreground': { light: '0 0% 9%', dark: '0 0% 98%' },
  muted: { light: '0 0% 96.1%', dark: '0 0% 14.9%' },
  'muted-foreground': { light: '0 0% 45.1%', dark: '0 0% 63.9%' },
  accent: { light: '0 0% 96.1%', dark: '0 0% 14.9%' },
  'accent-foreground': { light: '0 0% 9%', dark: '0 0% 98%' },
  destructive: { light: '0 84.2% 60.2%', dark: '0 62.8% 30.6%' },
  'destructive-foreground': { light: '0 0% 98%', dark: '0 0% 98%' },
  border: { light: '0 0% 89.8%', dark: '0 0% 14.9%' },
  input: { light: '0 0% 89.8%', dark: '0 0% 14.9%' },
  ring: { light: '0 0% 3.9%', dark: '0 0% 83.1%' },
  'chart-1': { light: '12 76% 61%', dark: '220 70% 50%' },
  'chart-2': { light: '173 58% 39%', dark: '160 60% 45%' },
  'chart-3': { light: '197 37% 24%', dark: '30 80% 55%' },
  'chart-4': { light: '43 74% 66%', dark: '280 65% 60%' },
  'chart-5': { light: '27 87% 67%', dark: '340 75% 55%' },
};

// 0.5rem at the default 16px root = 8px.
export const RADIUS = '0.5rem';
