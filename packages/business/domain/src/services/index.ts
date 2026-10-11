// Flat re-exports — consumers import from `@scani/domain/services`
// regardless of the underlying cluster directory.

export { ImportTargetGoneError } from '../lib/import-target-gone';
export { RecordNotAccessibleError } from '../lib/record-not-accessible';
// accounts/
export {
  AccountClassChange,
  AccountService,
  UnknownWrapper,
  WrapperOnLiabilityAccount,
} from './accounts/AccountService';
export { InstitutionService } from './accounts/InstitutionService';
export { siteHost } from './accounts/site-host';
// ai/
export { AIRouter } from './ai/AIRouter';
export { CsvColumnDetectionService } from './ai/CsvColumnDetectionService';
export { ScreenshotParsingService } from './ai/ScreenshotParsingService';
export { type ValuedAssetHistory, ValuedAssetService } from './assets/ValuedAssetService';
export {
  BackupRestorer,
  backupRecords,
  RESTORE_NEEDS_EMPTY,
  RestoreRefused,
  type RestoreReport,
  UNMATCHED_TOKEN_MARKER,
} from './backup/BackupRestorer';
export { type BackupRecord, BackupWriter, backupLine } from './backup/BackupWriter';
// backup/
export { BACKUP_FORMAT, BACKUP_VERSION } from './backup/backup-plan';
export {
  BackupTooLargeError,
  MAX_BACKUP_BYTES,
  UserBackupService,
} from './backup/UserBackupService';
export {
  CategoryNameError,
  parseImportedCategory,
} from './categories/category-names';
export {
  ImportedCategoryAssigner,
  type ImportedCategoryRow,
} from './categories/ImportedCategoryAssigner';
export { LearnedCategoryRules, type PlannedCategory } from './categories/LearnedCategoryRules';
export {
  CategoryConflictError,
  CategoryDepthError,
  type CategoryNode,
  CategoryNotFoundError,
  TransactionCategoryService,
} from './categories/TransactionCategoryService';
// documents/
export { DocumentDeletionService } from './documents/DocumentDeletionService';
export { DocumentDownloadService } from './documents/DocumentDownloadService';
export { DocumentIngestionService } from './documents/DocumentIngestionService';
export { DocumentReparseService } from './documents/DocumentReparseService';
export { DocumentRetentionService } from './documents/DocumentRetentionService';
export { UploadedFileService } from './documents/UploadedFileService';
// feeds/
export {
  FeedBatchRejected,
  FeedIngestService,
  type IngestResult,
} from './feeds/FeedIngestService';
export { legacyStatementBatch } from './feeds/legacy/statement-batch';
// foundation/
export {
  type ClassificationReport,
  FoundationClassificationService,
  type StaleLabel,
  type StaleLabelList,
  type StaleRelabelReport,
} from './foundation/FoundationClassificationService';
export { failureOf } from './foundation/failure-message';
export { BUDGET_APP_SOURCE_PREFIX } from './foundation/plan-feed-inputs';
export { staleLabelExitCode } from './foundation/stale-label-exit-code';
export {
  BalanceGapAnswerRejected,
  BalanceGapService,
} from './holdings/BalanceGapService';
// holdings/
export {
  type BalanceRefreshability,
  BalanceRefreshabilityService,
} from './holdings/BalanceRefreshabilityService';
export {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  WALLET_BALANCE_SYNC_SOURCE,
} from './holdings/balance-sync-sources';
export { EnrichHoldingsService } from './holdings/EnrichHoldingsService';
export {
  ExitedPositionProbe,
  type ExitedPositionProbeResult,
  type HoldingProbeCandidate,
} from './holdings/ExitedPositionProbe';
export { HistoryRebuildRangeService } from './holdings/HistoryRebuildRangeService';
export { HoldingQueryService } from './holdings/HoldingQueryService';
export { HoldingService } from './holdings/HoldingService';
export { HoldingsSyncHelper } from './holdings/HoldingsSyncHelper';
export {
  type DiscoveredAccountInfo,
  IntegrationImportService,
  type IntegrationImportTarget,
} from './holdings/IntegrationImportService';
export {
  ManualBalanceEditService,
  ManualEditFeeRefused,
} from './holdings/ManualBalanceEditService';
export { OpeningBalanceReconciliationService } from './holdings/OpeningBalanceReconciliationService';
export { SettlementAnswerReviewService } from './holdings/SettlementAnswerReviewService';
export {
  KeptHoldingNotFoundError,
  UnpriceableAirdropService,
} from './holdings/UnpriceableAirdropService';
// household/
export {
  HouseholdAccessService,
  type HouseholdMembership,
  type HouseholdRole,
  type VisibleAccount,
} from './household/HouseholdAccessService';
export {
  HouseholdMembershipService,
  type InviteState,
} from './household/HouseholdMembershipService';
export {
  type HouseholdAccountRow,
  type HouseholdHistory,
  type HouseholdNow,
  HouseholdViewService,
  type TrackedTwice,
} from './household/HouseholdViewService';
export { HouseholdError, type HouseholdErrorCode } from './household/household-errors';
export {
  type BudgetAppAccountTarget,
  type BudgetAppImportOutcome,
  type BudgetAppImportRecord,
  BudgetAppImportRefused,
  type BudgetAppImportRequest,
  BudgetAppImportService,
  type BudgetAppImportSummary,
  type BudgetAppImportTarget,
  type BudgetAppUndoOutcome,
} from './imports/BudgetAppImportService';
// income/
export { IncomeService } from './income/IncomeService';
export type { IncomeOutcome, IncomeSummary } from './income/types';
export { AccountClassService, NegativeBalanceRefused } from './liabilities/AccountClassService';
export {
  InvalidLiabilityTerms,
  LiabilityAccountNotFound,
  LiabilityTermsOnAssetAccount,
  LiabilityTermsService,
  userToday,
} from './liabilities/LiabilityTermsService';
export {
  type DispatchOutcome,
  OutboxDispatcher,
  type OutboxKickSource,
  type OutboxPublisher,
} from './outbox/OutboxDispatcher';
export { OutboxWriter } from './outbox/OutboxWriter';
// payments/
export { PaymentForecastService } from './payments/PaymentForecastService';
export { PaymentGroupService } from './payments/PaymentGroupService';
export {
  PaymentHasSettledOccurrencesError,
  PaymentService,
} from './payments/PaymentService';
export {
  RecurringSuggestionService,
  SuggestionNotFoundError,
} from './payments/RecurringSuggestionService';
// plan/
export {
  getPlanResolver,
  registerPlanResolver,
} from './plan/plan-resolver';
// portfolio/
export { AssetAllocationService } from './portfolio/AssetAllocationService';
export { DashboardService } from './portfolio/DashboardService';
export { EntityValuationService } from './portfolio/EntityValuationService';
export { type GainsByWrapper, GainsByWrapperService } from './portfolio/GainsByWrapperService';
export { GroupValuationService } from './portfolio/GroupValuationService';
export { PnLAtTimeService } from './portfolio/PnLAtTimeService';
export { PortfolioValuationService } from './portfolio/PortfolioValuationService';
export { PortfolioValueCache } from './portfolio/PortfolioValueCache';
export { RealizedLedgerService } from './portfolio/RealizedLedgerService';
export {
  TRANSIT_ASK_AFTER_DAYS,
  type TransitAnswerResult,
  type TransitCandidate,
  type TransitQuestion,
  TransitReviewService,
} from './portfolio/TransitReviewService';
// pricing/
export {
  filterProvidersByTokenType,
  HistoricalPriceBackfillService,
  placementOf,
} from './pricing/HistoricalPriceBackfillService';
export { PriceHubResolver } from './pricing/PriceHubResolver';
export { PriceReader } from './pricing/PriceReader';
export { PriceWarmupService } from './pricing/PriceWarmupService';
export { PriceWriter } from './pricing/PriceWriter';
export { PricingService } from './pricing/PricingService';
export { FX_BASELINE } from './pricing/price-hubs';
// review/
export { ReviewFeedService } from './ReviewFeedService';
// returns/
export { BenchmarkReturnService } from './returns/BenchmarkReturnService';
export {
  type ReturnsOutcome,
  type ReturnsRequest,
  type ReturnsResult,
  ReturnsService,
} from './returns/ReturnsService';
export { ReturnsSharedLoads } from './returns/ReturnsSharedLoads';
export {
  type CreateRuleResult,
  TransferReviewRuleService,
} from './TransferReviewRuleService';
export {
  type BulkResolveResult,
  MalformedCursorError,
  type SplitResolveResult,
  TransferReviewService,
} from './TransferReviewService';
// tokens/
export {
  SCAM_SCORE_VERSION,
  ScamTokenDetectionService,
} from './tokens/ScamTokenDetectionService';
export { TokenPriceHistoryService } from './tokens/TokenPriceHistoryService';
export { TokenService } from './tokens/TokenService';
export { judgeTokenIdentity } from './tokens/token-identity-safety';
// transactions/
export {
  noteOnResult,
  TransactionImportCoordinator,
  TransactionImportUnrecoverableError,
} from './transactions/TransactionImportCoordinator';
export { sourceForChainId, sourceForProvider } from './transactions/transaction-source';
export {
  type UntrackedArrivalAnswerResult,
  type UntrackedArrivalQuestion,
  UntrackedArrivalReviewService,
} from './UntrackedArrivalReviewService';
// users/
export { AppOpenRefreshService } from './users/AppOpenRefreshService';
export {
  ExpiredCredentialsError,
  IntegrationCredentialsService,
} from './users/IntegrationCredentialsService';
export {
  InvalidBaseCurrencyError,
  UserService,
} from './users/UserService';
export { UserWalletService } from './users/UserWalletService';
export { VaultService } from './users/VaultService';
export {
  type ChainProbeFailure,
  WalletDiscoveryService,
} from './users/WalletDiscoveryService';
