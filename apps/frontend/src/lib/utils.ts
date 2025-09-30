import { normalizeSymbol as sharedNormalizeSymbol } from '@scani/shared';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeSymbol(symbol: string): string {
  return sharedNormalizeSymbol(symbol);
}
