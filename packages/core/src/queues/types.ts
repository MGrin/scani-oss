/**
 * Job payload types. Every job in the single `scani-jobs` queue is a
 * scheduled repeatable — wallet import / exchange sync run synchronously
 * in the tRPC request path today, not via BullMQ. If those ever need to
 * move off the request path, add dedicated payload types here at that
 * point.
 */

export type ScheduledJobPayload = Record<string, never>;

export type JobPayload =
  | { name: 'pricing'; data: ScheduledJobPayload }
  | { name: 'wallet-balances'; data: ScheduledJobPayload }
  | { name: 'exchange-balances'; data: ScheduledJobPayload }
  | { name: 'apy-payouts'; data: ScheduledJobPayload };
