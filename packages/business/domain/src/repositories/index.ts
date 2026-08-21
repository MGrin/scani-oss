// Export all repositories for use by other apps in the monorepo.
//
// Wallet/exchange use cases read the institution-blockchain mapping
// table through `WalletDiscoveryService.resolveInstitutionCode` or
// directly via `InstitutionBlockchainMappingRepository`.

export { BaseRepository } from '@scani/db';
export { AccountRepository } from './AccountRepository';
export {
  ALERT_CLAIM_TTL_MS,
  type AlertCandidate,
  AlertDeliveryRepository,
  type ClaimedAlert,
} from './AlertDeliveryRepository';
export {
  DocumentExtractionRepository,
  type ExtractionOccurrenceLink,
} from './DocumentExtractionRepository';
export {
  type DocumentListCursor,
  type DocumentListItem,
  DocumentRepository,
  type ListDocumentsOptions,
} from './DocumentRepository';
export {
  AccountTypeRepository,
  InstitutionTypeRepository,
  TokenTypeRepository,
} from './EnumRepositories';
export { GroupRepository } from './GroupRepository';
export { HoldingApyConfigRepository } from './HoldingApyConfigRepository';
export { HoldingBalanceObservationRepository } from './HoldingBalanceObservationRepository';
export {
  type CoverageUpsertMerge,
  type CoverageUpsertResult,
  describeMergedCoverageRows,
  HoldingCoverageRepository,
} from './HoldingCoverageRepository';
export { HoldingExclusionRepository } from './HoldingExclusionRepository';
export { HoldingRepository } from './HoldingRepository';
export {
  type BulkUpsertMerge,
  type BulkUpsertResult,
  describeMergedRows,
  HoldingTransactionRepository,
  type TransactionRangeOptions,
} from './HoldingTransactionRepository';
export { InstitutionBlockchainMappingRepository } from './InstitutionBlockchainMappingRepository';
export { InstitutionRepository, type StaleSyncTarget } from './InstitutionRepository';
export {
  PaymentOccurrenceRepository,
  type UpcomingOccurrence,
} from './PaymentOccurrenceRepository';
export { PaymentRepository } from './PaymentRepository';
export {
  type IncludedHoldingScopeRow,
  PortfolioValueDailyRepository,
  type PortfolioValueDailyRow,
} from './PortfolioValueDailyRepository';
export {
  PushSubscriptionRepository,
  type ReminderCandidateRow,
} from './PushSubscriptionRepository';
export type { TokenPriceEditHistoryWithEditor } from './TokenPriceEditHistoryRepository';
export { TokenPriceEditHistoryRepository } from './TokenPriceEditHistoryRepository';
export { TokenPriceRepository } from './TokenPriceRepository';
export { TokenRepository } from './TokenRepository';
export { UserIntegrationCredentialsRepository } from './UserIntegrationCredentialsRepository';
export { UserJobRepository } from './UserJobRepository';
export {
  type AlertRecipient,
  type DigestRecipient,
  EMAIL_STREAMS,
  type EmailStream,
  UserRepository,
} from './UserRepository';
export { type StaleWalletTarget, UserWalletRepository } from './UserWalletRepository';
export { VaultRepository } from './VaultRepository';
export {
  type VendorDeleteImpact,
  VendorHasPaymentsError,
  VendorNameConflictError,
  VendorNotFoundError,
  VendorRepository,
} from './VendorRepository';
