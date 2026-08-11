import { z } from 'zod';

/**
 * Job kinds whose successful result is a proposal the user still has to
 * confirm, not a finished action. Single source of truth: the backend
 * filters the review feed by it, the frontend counts the badge by it, and
 * the renderer registry keys off it. Adding a reviewable kind means adding
 * it here and registering a renderer — nothing else.
 *
 * wallet-import: the worker writes the picker payload, not holdings directly.
 * The user can prune dust / scam tokens before they count toward portfolio totals.
 */
export const REVIEWABLE_JOB_NAMES = ['screenshot-parse', 'file-import', 'wallet-import'] as const;

export function isReviewableJobName(name: string): boolean {
  return (REVIEWABLE_JOB_NAMES as readonly string[]).includes(name);
}

export const reviewItemSchema = z.object({
  /** Source-prefixed so ids stay unique once non-job sources join. */
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  createdAt: z.date(),
  href: z.string().min(1),
});

export type ReviewItem = z.infer<typeof reviewItemSchema>;
