import { z } from 'zod';

// Canonical zod schemas for the most common input validations. Forms
// and tRPC inputs both should reach for these so error messages stay
// consistent and we don't re-test the same regex 12 times.

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .email('Please enter a valid email address');

export const urlSchema = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .url('Please enter a valid URL');

export const uuidSchema = z.string().uuid('Invalid identifier');

/**
 * Hex color — `#rrggbb` or `#rgb`. Used by groups + vaults where users
 * pick a color from a palette and the backend stores the literal string.
 */
export const hexColorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex color like #3b82f6');

/**
 * Non-empty trimmed string. Sentinel for "this field is required and
 * blank-stripping is automatic." Avoids the common `z.string().min(1)`
 * accepting whitespace-only inputs.
 */
export function requiredString(label: string): z.ZodString {
  return z.string().trim().min(1, `${label} is required`);
}
