/**
 * Job payload types. Scheduled jobs have no payload (empty object); on-demand
 * jobs carry the identifiers the worker needs to pick up the right row.
 */

// Scheduled jobs take no payload.
export type ScheduledJobPayload = Record<string, never>;

export interface WalletImportPayload {
  userId: string;
  walletId: string;
  // The backend must not embed secrets. Worker re-reads the encrypted credentials
  // from the DB.
}

export interface ExchangeSyncPayload {
  userId: string;
  integrationCredentialId: string;
}

export type JobPayload =
  | { name: 'pricing'; data: ScheduledJobPayload }
  | { name: 'wallet-balances'; data: ScheduledJobPayload }
  | { name: 'exchange-balances'; data: ScheduledJobPayload }
  | { name: 'apy-payouts'; data: ScheduledJobPayload }
  | { name: 'wallet-import'; data: WalletImportPayload }
  | { name: 'exchange-sync'; data: ExchangeSyncPayload };
