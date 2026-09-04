import * as schema from '@scani/db/schema';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * What "delete all my data" does to every table keyed on `users.id`, and to
 * every column of the `users` row it deliberately leaves standing.
 *
 * **Why a manifest rather than a list of deletes.** The flow keeps the user
 * row, so no cascade off `users.id` ever fires and every referencing table has
 * to be named. A hand-written list of names rots silently: the flow was
 * correct when it was written on 2026-05-12, `documents` arrived on
 * 2026-08-11, and twelve tables were surviving a delete-everything by the time
 * anyone counted (SC-1014, SC-1018). Adding ten more deletes would set the
 * same trap for table thirteen.
 *
 * So this is a CLASSIFICATION of the whole FK set, not a subset of it, and
 * `tests/use-cases/user-data-deletion-manifest.test.ts` fails the build when a
 * new FK on `users.id` — or a new column on `users` — appears here
 * unclassified. Writing the schema is the loud step; re-reading a use case
 * nobody has a reason to open is not.
 */

/** A table referencing `users.id`, and what this flow does to it. */
export type TableDisposition =
  | {
      kind: 'delete';
      table: PgTable;
      userColumn: AnyPgColumn;
      /** One column echoed back per removed row, for the audit log's counts. */
      echo: AnyPgColumn;
      note?: string;
    }
  | {
      /** The row stays; the column naming this user is set to NULL. */
      kind: 'anonymise';
      table: PgTable;
      userColumn: AnyPgColumn;
      reason: string;
    }
  | { kind: 'keep'; table: PgTable; userColumn: AnyPgColumn; reason: string };

/**
 * ORDER IS A CORRECTNESS CONSTRAINT, not presentation. Two constraints bind:
 *
 * - `payments.vendor_id` is `ON DELETE RESTRICT`, so payments must go before
 *   vendors or the transaction aborts.
 * - `payment_occurrences.matched_extraction_id` is `ON DELETE SET NULL`, so
 *   deleting documents while payments still stand would quietly strip settled
 *   occurrences of the invoice that evidences them — the loss
 *   `DocumentDeletionService` refuses one document at a time. Deleting
 *   payments first takes the occurrences with it, so there is nothing to strip.
 *
 * Everything else is ordered parent-before-child only to spare Postgres the
 * cascade and SET-NULL churn on rows that are about to be deleted anyway.
 */
export const USER_DATA_TABLE_DISPOSITIONS: readonly TableDisposition[] = [
  // PnL / historical-balance tables. Explicit even where the accounts delete
  // below would cascade them, because the returned counts are what the audit
  // log reports as "here is what we removed".
  {
    kind: 'delete',
    table: schema.portfolioValueDaily,
    userColumn: schema.portfolioValueDaily.userId,
    echo: schema.portfolioValueDaily.snapshotDate,
  },
  {
    kind: 'delete',
    table: schema.holdingTransactions,
    userColumn: schema.holdingTransactions.userId,
    echo: schema.holdingTransactions.id,
  },
  {
    kind: 'delete',
    table: schema.holdingBalanceObservations,
    userColumn: schema.holdingBalanceObservations.userId,
    echo: schema.holdingBalanceObservations.id,
  },
  {
    kind: 'delete',
    table: schema.holdings,
    userColumn: schema.holdings.userId,
    echo: schema.holdings.id,
  },

  // Before documents and before vendors — see the ordering note above.
  {
    kind: 'delete',
    table: schema.payments,
    userColumn: schema.payments.userId,
    echo: schema.payments.id,
  },

  // The uploaded files themselves: bank statements, portfolio screenshots and
  // invoices. `r2Key` is echoed because the stored objects are deleted after
  // the transaction commits — see the use case for why that order and not the
  // other one.
  {
    kind: 'delete',
    table: schema.documents,
    userColumn: schema.documents.userId,
    echo: schema.documents.r2Key,
    note: 'Takes `document_extractions` with it by cascade.',
  },
  {
    kind: 'delete',
    table: schema.vendors,
    userColumn: schema.vendors.userId,
    echo: schema.vendors.id,
  },

  // `holding_coverage` is keyed by (accountId, tokenId) with no userId of its
  // own; its accountId FK cascades, so this delete cleans it.
  {
    kind: 'delete',
    table: schema.accounts,
    userColumn: schema.accounts.userId,
    echo: schema.accounts.id,
  },
  {
    kind: 'delete',
    table: schema.entities,
    userColumn: schema.entities.userId,
    echo: schema.entities.id,
  },
  {
    kind: 'delete',
    table: schema.vaults,
    userColumn: schema.vaults.userId,
    echo: schema.vaults.id,
  },
  {
    kind: 'delete',
    table: schema.groups,
    userColumn: schema.groups.userId,
    echo: schema.groups.id,
  },
  {
    kind: 'delete',
    table: schema.userWallets,
    userColumn: schema.userWallets.userId,
    echo: schema.userWallets.id,
  },
  {
    kind: 'delete',
    table: schema.holdingExclusions,
    userColumn: schema.holdingExclusions.userId,
    echo: schema.holdingExclusions.id,
  },
  {
    kind: 'delete',
    table: schema.transferReviewRules,
    userColumn: schema.transferReviewRules.userId,
    echo: schema.transferReviewRules.id,
  },

  // Not merely this user's copy of shared bookkeeping — leaving it is an
  // active fault. `CredentialPool.pickCandidate` selects from this table
  // ALONE (LRU, `limit 1`) and only afterwards resolves the credential, and
  // the failed resolve returns before `bumpLastBorrowed`. So a row that
  // outlives its `user_integration_credentials` row keeps winning the LRU and
  // the pool stops borrowing for that institution entirely.
  {
    kind: 'delete',
    table: schema.credentialPoolState,
    userColumn: schema.credentialPoolState.userId,
    echo: schema.credentialPoolState.userId,
  },
  {
    kind: 'delete',
    table: schema.userIntegrationCredentials,
    userColumn: schema.userIntegrationCredentials.userId,
    echo: schema.userIntegrationCredentials.id,
  },
  {
    kind: 'delete',
    table: schema.alertDeliveries,
    userColumn: schema.alertDeliveries.userId,
    echo: schema.alertDeliveries.id,
  },
  {
    kind: 'delete',
    table: schema.pushSubscriptions,
    userColumn: schema.pushSubscriptions.userId,
    echo: schema.pushSubscriptions.id,
  },
  {
    kind: 'delete',
    table: schema.userCostBasisMethodChanges,
    userColumn: schema.userCostBasisMethodChanges.userId,
    echo: schema.userCostBasisMethodChanges.id,
  },

  // Last, so the ids it returns are the complete set the post-commit BullMQ
  // purge has to walk.
  {
    kind: 'delete',
    table: schema.userJobs,
    userColumn: schema.userJobs.userId,
    echo: schema.userJobs.jobId,
  },

  {
    kind: 'anonymise',
    table: schema.credentialPoolBorrowLog,
    userColumn: schema.credentialPoolBorrowLog.borrowedFromUserId,
    reason:
      'An operational audit of the shared credential pool with no user-facing reader — one insert in `credential-pool.ts` writes it and nothing anywhere reads the column. Its FK is already ON DELETE SET NULL, so the schema has decided the user link is severable; severing it here leaves the pool its own history and leaves no row naming this account.',
  },

  {
    kind: 'keep',
    table: schema.userAccounts,
    userColumn: schema.userAccounts.userId,
    reason:
      "Better-Auth's provider linkage and password hash — this row IS the ability to sign in. The settings copy commits to emptying the account and leaving the login working; removing this deletes the account instead of its data, which is a different product decision and not one this flow makes.",
  },
  {
    kind: 'keep',
    table: schema.userSessions,
    userColumn: schema.userSessions.userId,
    reason:
      'The live sessions are the login. Deleting them signs the account out of every device including the browser that asked for the deletion, which turns "your login remains" into a logout. The residual is bounded and nothing else here is: each row carries its own `expires_at` and disappears on its own.',
  },
  {
    kind: 'keep',
    table: schema.tokenPriceEditHistory,
    userColumn: schema.tokenPriceEditHistory.editedByUserId,
    reason:
      "An admin acting on a GLOBAL token price every user sees, not this account's own portfolio data. Its FK is ON DELETE RESTRICT — the schema treats the attribution as non-severable, because a price override with no author is an unattributable change to shared data.",
  },
];

/** What happens to a column of the `users` row, which this flow keeps. */
export type UserColumnDisposition =
  | { kind: 'clear'; column: AnyPgColumn; note?: string }
  | { kind: 'keep'; column: AnyPgColumn; reason: string };

/**
 * The FK enumeration above can only see OTHER tables. The user's own row
 * survives by design and holds columns of its own, so it needs the same
 * treatment or the promise is still false with every table empty: the observed
 * burn figures are amounts the user typed about their own spending, and they
 * were surviving a delete-everything for exactly the reason the twelve tables
 * were — nothing enumerated them.
 */
export const USER_ROW_COLUMN_DISPOSITIONS: readonly UserColumnDisposition[] = [
  { kind: 'keep', column: schema.users.id, reason: 'The account itself; the flow keeps the row.' },
  {
    kind: 'keep',
    column: schema.users.email,
    reason: 'The login identifier. Removing it is removing the account.',
  },
  {
    kind: 'keep',
    column: schema.users.emailVerified,
    reason:
      'A property of the login, and clearing it would lock the account out of flows it has already passed.',
  },
  {
    kind: 'keep',
    column: schema.users.name,
    reason:
      'Identity on the login that remains, and NOT NULL — there is no empty value to write that is not itself a made-up one.',
  },
  {
    kind: 'keep',
    column: schema.users.avatar,
    reason: 'Identity on the login that remains; carries no portfolio content.',
  },
  {
    kind: 'keep',
    column: schema.users.image,
    reason: "Better-Auth's canonical twin of `avatar`; same reasoning.",
  },
  {
    kind: 'keep',
    column: schema.users.timezone,
    reason:
      'A display preference for the login that remains. Clearing it makes the account silently skip time-of-day scheduling until the app is opened again.',
  },
  {
    kind: 'keep',
    column: schema.users.baseCurrencyId,
    reason:
      'A display preference, not a figure — it says which currency totals are rendered in, and every total it applied to is gone.',
  },
  {
    kind: 'keep',
    column: schema.users.costBasisMethod,
    reason:
      'A preference, NOT NULL with a default. Resetting it would change how a rebuilt portfolio is computed without the user asking.',
  },

  // The one class of user-entered CONTENT on this row: figures about their own
  // spending. Both triples move together or the row violates
  // `users_observed_burn_override_complete` / `users_observed_burn_one_answer`;
  // all six NULL is "no answer", which every account starts at.
  { kind: 'clear', column: schema.users.observedBurnOverride, note: 'An amount the user typed.' },
  { kind: 'clear', column: schema.users.observedBurnOverrideCurrencyId },
  { kind: 'clear', column: schema.users.observedBurnOverrideAt },
  {
    kind: 'clear',
    column: schema.users.observedBurnConfirmedValue,
    note: 'An amount the user agreed with.',
  },
  { kind: 'clear', column: schema.users.observedBurnConfirmedCurrencyId },
  { kind: 'clear', column: schema.users.observedBurnConfirmedAt },

  {
    kind: 'keep',
    column: schema.users.firstExportAt,
    reason:
      'A one-bit activation marker holding no content, and NULL is defined to mean "unknown" rather than "never" — clearing it would assert something false rather than nothing.',
  },
  {
    kind: 'keep',
    column: schema.users.emailUnsubscribeToken,
    reason:
      "The bearer credential every unsubscribe link authenticates on. Rotating it here would break links already in the account's inbox.",
  },
  {
    kind: 'keep',
    column: schema.users.digestOptOutAt,
    reason:
      'A consent record. Clearing it re-subscribes somebody who opted out, which is the one direction that cannot be undone by them.',
  },
  {
    kind: 'keep',
    column: schema.users.alertsOptOutAt,
    reason: 'A consent record; same reasoning as `digestOptOutAt`.',
  },
  {
    kind: 'keep',
    column: schema.users.digestLastSentAt,
    reason:
      "A retry guard for the digest job. Clearing it lets a retry mail the account twice; it holds no content of the user's.",
  },
  {
    kind: 'keep',
    column: schema.users.createdAt,
    reason: 'When the login was created. The beta grandfathering promise is keyed to it.',
  },
  {
    kind: 'keep',
    column: schema.users.updatedAt,
    reason:
      'Row bookkeeping written by the ORM rather than by the user, and this flow writes the row, so whatever is here is about the deletion itself.',
  },
];
