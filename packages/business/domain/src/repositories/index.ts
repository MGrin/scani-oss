// Export all repositories for use by other apps in the monorepo.
//
// Wallet/exchange use cases read the institution-blockchain mapping
// table through `WalletDiscoveryService.resolveInstitutionCode` or
// directly via `InstitutionBlockchainMappingRepository`.
export { AccountRepository } from './AccountRepository';
export {
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
} from './DocumentRepository';
export {
  EngineShadowReportRepository,
  type ShadowRunSummary,
} from './EngineShadowReportRepository';
export { EntityRepository } from './EntityRepository';
export {
  AccountTypeRepository,
  InstitutionTypeRepository,
} from './EnumRepositories';
export { GroupRepository } from './GroupRepository';
export { HoldingApyConfigRepository } from './HoldingApyConfigRepository';
export { HoldingBalanceObservationRepository } from './HoldingBalanceObservationRepository';
export { HoldingExclusionRepository } from './HoldingExclusionRepository';
export { HoldingRepository } from './HoldingRepository';
export {
  describeMergedRows,
  HoldingTransactionRepository,
} from './HoldingTransactionRepository';
export { InstitutionRepository, type StaleSyncTarget } from './InstitutionRepository';
export { OperatorAlarmRepository } from './OperatorAlarmRepository';
export { PaymentOccurrenceRepository } from './PaymentOccurrenceRepository';
export { PaymentRepository } from './PaymentRepository';
export {
  type IncludedDailyTotalsRow,
  type IncludedHoldingScopeRow,
  PortfolioValueDailyRepository,
} from './PortfolioValueDailyRepository';
export { PushSubscriptionRepository } from './PushSubscriptionRepository';
export { TokenPriceRepository } from './TokenPriceRepository';
export { TokenRepository } from './TokenRepository';
export { UserJobRepository } from './UserJobRepository';
export {
  type AlertRecipient,
  EMAIL_STREAMS,
  type EmailStream,
  UserRepository,
} from './UserRepository';
export {
  type ScamVerdict,
  UserTokenScamVerdictRepository,
} from './UserTokenScamVerdictRepository';
export { type StaleWalletTarget, UserWalletRepository } from './UserWalletRepository';
export { VaultRepository } from './VaultRepository';
export {
  VendorHasPaymentsError,
  VendorNameConflictError,
  VendorNotFoundError,
  VendorRepository,
} from './VendorRepository';
