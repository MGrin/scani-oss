import * as schema from '@scani/db/schema';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

export const BACKUP_FORMAT = 'scani-backup';
export const BACKUP_VERSION = 1;

/**
 * How a backed-up table's rows are found for one account: by a column naming
 * the user, or through a parent table that is itself backed up.
 */
type BackupOwner =
  | { by: 'user'; column: AnyPgColumn }
  | { by: 'parent'; column: AnyPgColumn; parent: PgTable };

export interface BackedUpTable {
  table: PgTable;
  owner: BackupOwner;
}

const byUser = (table: PgTable, column: AnyPgColumn): BackedUpTable => ({
  table,
  owner: { by: 'user', column },
});
const byParent = (table: PgTable, column: AnyPgColumn, parent: PgTable): BackedUpTable => ({
  table,
  owner: { by: 'parent', column, parent },
});

/**
 * Every table a backup carries, in the order a restore inserts them: a table
 * comes after every backed-up table it references. `tokens` and `institutions`
 * carry only the account's own custom rows; the shared catalog rows they
 * reference travel as `catalog` records instead, matched on the target.
 */
export const BACKED_UP_TABLES: readonly BackedUpTable[] = [
  byUser(schema.entities, schema.entities.userId),
  byUser(schema.institutions, schema.institutions.createdByUserId),
  byUser(schema.tokens, schema.tokens.createdByUserId),
  byParent(schema.tokenPrices, schema.tokenPrices.tokenId, schema.tokens),
  byUser(schema.tokenPriceEditHistory, schema.tokenPriceEditHistory.editedByUserId),
  byUser(schema.accounts, schema.accounts.userId),
  // A loan's or card's terms (SC-1640): what the account owes and on what conditions.
  byParent(schema.liabilityTerms, schema.liabilityTerms.accountId, schema.accounts),
  byUser(schema.userWallets, schema.userWallets.userId),
  byUser(schema.holdings, schema.holdings.userId),
  byParent(schema.holdingApyConfigs, schema.holdingApyConfigs.holdingId, schema.holdings),
  // Not derived: besides the ledger's bounds it holds claims only their
  // writers make (complete history, where the source's history starts, the
  // reconciler's opening), and cost basis reads the first of them.
  byParent(schema.holdingCoverage, schema.holdingCoverage.holdingId, schema.holdings),
  byUser(schema.transferReviewRules, schema.transferReviewRules.userId),
  byUser(schema.judgmentDecisions, schema.judgmentDecisions.userId),
  byUser(schema.feedInputs, schema.feedInputs.userId),
  byParent(schema.feedInputWindows, schema.feedInputWindows.inputId, schema.feedInputs),
  byUser(schema.feedMatchRules, schema.feedMatchRules.userId),
  byUser(schema.transactionCategories, schema.transactionCategories.userId),
  byUser(schema.holdingTransactions, schema.holdingTransactions.userId),
  byUser(schema.holdingBalanceObservations, schema.holdingBalanceObservations.userId),
  byUser(schema.retiredGapAnswers, schema.retiredGapAnswers.userId),
  byUser(schema.groups, schema.groups.userId),
  byParent(schema.holdingGroups, schema.holdingGroups.holdingId, schema.holdings),
  byParent(schema.holdingGroupExclusions, schema.holdingGroupExclusions.holdingId, schema.holdings),
  byParent(schema.accountGroups, schema.accountGroups.accountId, schema.accounts),
  byUser(schema.vaults, schema.vaults.userId),
  byParent(schema.vaultHoldings, schema.vaultHoldings.vaultId, schema.vaults),
  byUser(schema.vendors, schema.vendors.userId),
  byParent(schema.vendorAliases, schema.vendorAliases.vendorId, schema.vendors),
  byParent(schema.vendorGroups, schema.vendorGroups.vendorId, schema.vendors),
  byUser(schema.payments, schema.payments.userId),
  byParent(schema.paymentOccurrences, schema.paymentOccurrences.paymentId, schema.payments),
  byParent(schema.paymentGroups, schema.paymentGroups.paymentId, schema.payments),
  byParent(schema.paymentGroupExclusions, schema.paymentGroupExclusions.paymentId, schema.payments),
  byParent(
    schema.paymentOccurrenceGroups,
    schema.paymentOccurrenceGroups.occurrenceId,
    schema.paymentOccurrences
  ),
  byUser(schema.holdingExclusions, schema.holdingExclusions.userId),
  byUser(schema.userTokenScamVerdicts, schema.userTokenScamVerdicts.userId),
  byUser(schema.recurringSuggestionDismissals, schema.recurringSuggestionDismissals.userId),
  byUser(schema.userCostBasisMethodChanges, schema.userCostBasisMethodChanges.userId),
];

/**
 * Shared rows a backed-up row may reference. They are not the account's, so
 * they travel as `catalog` records and a restore matches them on the target.
 */
export const BACKUP_CATALOG_TABLES: readonly PgTable[] = [
  schema.tokens,
  schema.tokenTypes,
  schema.institutions,
  schema.institutionTypes,
  schema.accountTypes,
];

const SIGN_IN = 'Sign-in and access grants belong to the instance that issued them.';
const SECRET =
  "Encrypted under the source deployment's key, so it cannot be read anywhere else. The person reconnects the integration.";
const DERIVED = 'Derived from the evidence, and rebuilt from it after a restore.';
const INSTANCE_HISTORY =
  "The source instance's job, delivery and audit history, not the account's data.";
const HOUSEHOLD =
  'Membership is a relation between people; a restore lands in an empty account that belongs to no household.';
const UPLOAD_UNDO =
  'The undo handle of an upload into the source instance. A restore writes every row anew, so there is no upload to undo.';
const FILES =
  'The stored files are not in a backup (v1). Their rows without the files would be broken downloads.';

/**
 * Every account-owned table a backup leaves out, with the reason. With
 * `BACKED_UP_TABLES` it covers every table naming `users.id`, and every table
 * hanging off a backed-up one: `backup-plan.test.ts` fails when a new table is
 * neither.
 */
export const NOT_BACKED_UP: ReadonlyArray<{ table: PgTable; reason: string }> = [
  { table: schema.userAccounts, reason: SIGN_IN },
  { table: schema.userSessions, reason: SIGN_IN },
  { table: schema.userTwoFactors, reason: SIGN_IN },
  { table: schema.userPasskeys, reason: SIGN_IN },
  { table: schema.oauthAccessTokens, reason: SIGN_IN },
  { table: schema.oauthRefreshTokens, reason: SIGN_IN },
  { table: schema.oauthConsents, reason: SIGN_IN },
  { table: schema.oauthClients, reason: SIGN_IN },
  { table: schema.personalAccessTokens, reason: SIGN_IN },
  { table: schema.billCalendarFeeds, reason: SIGN_IN },
  { table: schema.userIntegrationCredentials, reason: SECRET },
  { table: schema.credentialPoolState, reason: SECRET },
  { table: schema.credentialPoolBorrowLog, reason: SECRET },
  { table: schema.cloudApiKeys, reason: SECRET },
  {
    table: schema.pushSubscriptions,
    reason: "Bound to one browser and to the source instance's push key.",
  },
  { table: schema.documents, reason: FILES },
  { table: schema.documentExtractions, reason: FILES },
  { table: schema.portfolioValueDaily, reason: DERIVED },
  { table: schema.returnsLastComplete, reason: DERIVED },
  { table: schema.engineShadowDifferences, reason: DERIVED },
  { table: schema.userJobs, reason: INSTANCE_HISTORY },
  { table: schema.outboxEvents, reason: INSTANCE_HISTORY },
  { table: schema.agentCalls, reason: INSTANCE_HISTORY },
  { table: schema.agentWrites, reason: INSTANCE_HISTORY },
  { table: schema.agentWriteLocks, reason: INSTANCE_HISTORY },
  { table: schema.alertDeliveries, reason: INSTANCE_HISTORY },
  { table: schema.userBackups, reason: 'A backup does not carry other backups.' },
  { table: schema.households, reason: HOUSEHOLD },
  { table: schema.householdMembers, reason: HOUSEHOLD },
  { table: schema.householdInvites, reason: HOUSEHOLD },
  { table: schema.accountShares, reason: HOUSEHOLD },
  { table: schema.budgetAppImports, reason: UPLOAD_UNDO },
  { table: schema.budgetAppImportEntries, reason: UPLOAD_UNDO },
  {
    table: schema.institutionBlockchainMappings,
    reason: "Catalog data the instance maintains for its own institutions, not the account's.",
  },
];

/**
 * The `users` columns a backup carries: the account's settings. Sign-in,
 * consent, unsubscribe and nudge columns stay with the target account.
 */
export const BACKED_UP_USER_COLUMNS = [
  'name',
  'timezone',
  'baseCurrencyId',
  'costBasisMethod',
  'language',
  'digestOptOutAt',
  'alertsOptOutAt',
] as const satisfies ReadonlyArray<keyof typeof schema.users.$inferSelect>;

export const USER_COLUMNS_LEFT_OUT = [
  'id',
  'email',
  'emailVerified',
  'twoFactorEnabled',
  'avatar',
  'image',
  'firstExportAt',
  'signupSource',
  'emailUnsubscribeToken',
  'digestLastSentAt',
  'activationNudgeSentAt',
  'onboardingOptOutAt',
  'appSeenAt',
  'createdAt',
  'updatedAt',
] as const satisfies ReadonlyArray<keyof typeof schema.users.$inferSelect>;
