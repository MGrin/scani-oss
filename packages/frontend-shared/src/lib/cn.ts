import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional className merger used across every shadcn primitive. Relies
 * on `clsx` for falsy-value filtering + `tailwind-merge` to de-dupe
 * conflicting utility classes (e.g. `p-2 p-4` → `p-4`).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
