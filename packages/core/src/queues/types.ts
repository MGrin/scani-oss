/**
 * Job payload types for the single `scani-jobs` queue.
 *
 * Scheduled jobs (pricing, wallet-balances, exchange-balances, apy-payouts)
 * carry no data — BullMQ's repeatable scheduler fires them with an empty
 * payload.
 *
 * User-initiated jobs carry a `userId` (for WebSocket fan-out routing) plus
 * a `requestId` (client-generated UUID) so the producer can compute
 * deterministic job ids and BullMQ can dedupe rapid duplicate submissions.
 *
 * Payloads must never contain raw file bytes or plaintext credentials —
 * large blobs go through R2 (payload carries the storage key) and
 * credentials are AES-GCM encrypted before enqueue (see
 * packages/core/src/security/credentials.ts).
 */

export type ScheduledJobPayload = Record<string, never>;

export interface UserJobBase {
  userId: string;
  requestId: string;
}

export interface ScreenshotParseJob extends UserJobBase {
  r2Keys: string[];
  provider: string;
  accountType: string;
  expectedCurrency: string;
  context?: string;
  minConfidence?: number;
  accountId?: string;
}

export interface ExchangeImportJob extends UserJobBase {
  /**
   * Institution ID — credentials are already stored encrypted at rest by
   * `IntegrationCredentialsService` before the job is enqueued, so the
   * payload carries only the institution reference, not the credentials
   * themselves.
   */
  institutionId: string;
  provider: string;
}

export interface WalletImportJob extends UserJobBase {
  chain: string;
  address: string;
  label?: string;
}

export interface FileImportJob extends UserJobBase {
  r2Key: string;
  fileType: 'csv' | 'ofx' | 'qif';
  accountId: string;
  enrich?: boolean;
}

export interface HoldingPriceUpdateJob extends UserJobBase {
  holdingId: string;
  priceUsd: number;
  priceSource: string;
}

export interface UserDataDeleteJob extends UserJobBase {}

export type JobPayload =
  | { name: 'pricing'; data: ScheduledJobPayload }
  | { name: 'wallet-balances'; data: ScheduledJobPayload }
  | { name: 'exchange-balances'; data: ScheduledJobPayload }
  | { name: 'apy-payouts'; data: ScheduledJobPayload }
  | { name: 'screenshot-parse'; data: ScreenshotParseJob }
  | { name: 'exchange-import'; data: ExchangeImportJob }
  | { name: 'wallet-import'; data: WalletImportJob }
  | { name: 'file-import'; data: FileImportJob }
  | { name: 'holding-price-update'; data: HoldingPriceUpdateJob }
  | { name: 'user-data-delete'; data: UserDataDeleteJob };

export type JobDataFor<Name extends JobPayload['name']> = Extract<
  JobPayload,
  { name: Name }
>['data'];
