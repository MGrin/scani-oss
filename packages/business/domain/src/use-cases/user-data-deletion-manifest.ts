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
  // The last eligible returns answer per window (SC-1694): derived from the
  // rows above, so it goes with them.
  {
    kind: 'delete',
    table: schema.returnsLastComplete,
    userColumn: schema.returnsLastComplete.userId,
    echo: schema.returnsLastComplete.windowKey,
  },
  // Copies of ledger rows the owner retired (SC-1453). Append-only everywhere
  // else, and this is the one delete it has: the account's own data going.
  {
    kind: 'delete',
    table: schema.retiredGapAnswers,
    userColumn: schema.retiredGapAnswers.userId,
    echo: schema.retiredGapAnswers.id,
  },
  // The foundation shadow's balance differences for this user. Ahead of the
  // holdings they name ON DELETE SET NULL, and so ahead of the accounts too.
  // Price differences carry no user and are pruned with their run.
  {
    kind: 'delete',
    table: schema.engineShadowDifferences,
    userColumn: schema.engineShadowDifferences.userId,
    echo: schema.engineShadowDifferences.id,
  },
  {
    kind: 'delete',
    table: schema.holdingTransactions,
    userColumn: schema.holdingTransactions.userId,
    echo: schema.holdingTransactions.id,
  },
  {
    kind: 'delete',
    table: schema.transactionCategories,
    userColumn: schema.transactionCategories.userId,
    echo: schema.transactionCategories.id,
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
  // A backup holds every ledger row and reading the account has, so its
  // stored object goes with the account, after the commit, like a document's.
  {
    kind: 'delete',
    table: schema.userBackups,
    userColumn: schema.userBackups.userId,
    echo: schema.userBackups.storageKey,
  },
  {
    kind: 'delete',
    table: schema.budgetAppImports,
    userColumn: schema.budgetAppImports.userId,
    echo: schema.budgetAppImports.id,
    note: 'Takes `budget_app_import_entries` with it by cascade.',
  },
  {
    kind: 'delete',
    table: schema.vendors,
    userColumn: schema.vendors.userId,
    echo: schema.vendors.id,
  },

  // Feed inputs belong to an account and cascade from it, as do their windows
  // and rules. Explicit and ahead of the accounts delete for the same reason as
  // the PnL tables above: the returned counts are the audit log's "here is
  // what we removed". Rules go before the inputs they hang off.
  {
    kind: 'delete',
    table: schema.feedMatchRules,
    userColumn: schema.feedMatchRules.userId,
    echo: schema.feedMatchRules.id,
  },
  {
    kind: 'delete',
    table: schema.feedInputs,
    userColumn: schema.feedInputs.userId,
    echo: schema.feedInputs.id,
    note: 'Takes `feed_input_windows` with it by cascade.',
  },
  {
    kind: 'delete',
    table: schema.judgmentDecisions,
    userColumn: schema.judgmentDecisions.userId,
    echo: schema.judgmentDecisions.id,
  },
  {
    kind: 'delete',
    table: schema.outboxEvents,
    userColumn: schema.outboxEvents.userId,
    echo: schema.outboxEvents.id,
  },

  // Household rows (SC-1647). Only the owner shares an account, so `shared_by`
  // names the owner, and the shares go before the accounts they echo.
  {
    kind: 'delete',
    table: schema.accountShares,
    userColumn: schema.accountShares.sharedBy,
    echo: schema.accountShares.accountId,
  },
  {
    kind: 'delete',
    table: schema.householdInvites,
    userColumn: schema.householdInvites.invitedBy,
    echo: schema.householdInvites.id,
  },
  {
    kind: 'delete',
    table: schema.householdMembers,
    userColumn: schema.householdMembers.userId,
    echo: schema.householdMembers.householdId,
  },
  {
    kind: 'anonymise',
    table: schema.households,
    userColumn: schema.households.createdBy,
    reason:
      'The household outlives its creator: the other members keep it, so only the link to the person is severed.',
  },
  // `holding_coverage` is keyed by (accountId, tokenId) with no userId of its
  // own; its accountId FK cascades, so this delete cleans it.
  {
    kind: 'delete',
    table: schema.accounts,
    userColumn: schema.accounts.userId,
    echo: schema.accounts.id,
  },
  // An institution the user typed in is theirs alone, so it goes with them.
  // After the accounts, so their echo is intact; nobody else's can exist (SC-1354).
  {
    kind: 'delete',
    table: schema.institutions,
    userColumn: schema.institutions.createdByUserId,
    echo: schema.institutions.id,
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
    table: schema.userTokenScamVerdicts,
    userColumn: schema.userTokenScamVerdicts.userId,
    echo: schema.userTokenScamVerdicts.id,
  },
  {
    kind: 'delete',
    table: schema.recurringSuggestionDismissals,
    userColumn: schema.recurringSuggestionDismissals.userId,
    echo: schema.recurringSuggestionDismissals.id,
  },
  {
    kind: 'delete',
    table: schema.transferReviewRules,
    userColumn: schema.transferReviewRules.userId,
    echo: schema.transferReviewRules.id,
  },

  // This user's own bookkeeping, so it goes whatever the pool does with
  // it. It USED to be an active fault as well: `pickCandidate` selected
  // from this table alone, so a row outliving its
  // `user_integration_credentials` row kept winning the LRU and wedged
  // the institution. SC-1020 made the selector join the credential
  // table, so a surviving row is now inert rather than harmful — the
  // reason changed, the entry did not.
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
  // An agent's token reads the data being erased, so it goes with it (SC-1614).
  {
    kind: 'delete',
    table: schema.personalAccessTokens,
    userColumn: schema.personalAccessTokens.userId,
    echo: schema.personalAccessTokens.id,
  },
  // A calendar feed URL reads the bills being erased (SC-1654).
  {
    kind: 'delete',
    table: schema.billCalendarFeeds,
    userColumn: schema.billCalendarFeeds.userId,
    echo: schema.billCalendarFeeds.userId,
  },
  // An AI app connected through OAuth reads the data this flow empties, so
  // its consent and tokens go with it (SC-1615).
  {
    kind: 'delete',
    table: schema.oauthAccessTokens,
    userColumn: schema.oauthAccessTokens.userId,
    echo: schema.oauthAccessTokens.id,
  },
  {
    kind: 'delete',
    table: schema.oauthRefreshTokens,
    userColumn: schema.oauthRefreshTokens.userId,
    echo: schema.oauthRefreshTokens.id,
  },
  {
    kind: 'delete',
    table: schema.oauthConsents,
    userColumn: schema.oauthConsents.userId,
    echo: schema.oauthConsents.id,
  },
  {
    kind: 'delete',
    table: schema.oauthClients,
    userColumn: schema.oauthClients.userId,
    echo: schema.oauthClients.id,
  },
  // The agent activity log holds whole before/after copies of the rows this
  // flow erases, so it goes with them; its changes and snapshots cascade
  // (SC-1617).
  {
    kind: 'delete',
    table: schema.agentWrites,
    userColumn: schema.agentWrites.userId,
    echo: schema.agentWrites.id,
  },
  {
    kind: 'delete',
    table: schema.agentWriteLocks,
    userColumn: schema.agentWriteLocks.userId,
    echo: schema.agentWriteLocks.userId,
  },
  // What the user's agents asked for, arguments included (SC-1618).
  {
    kind: 'delete',
    table: schema.agentCalls,
    userColumn: schema.agentCalls.userId,
    echo: schema.agentCalls.id,
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
    kind: 'anonymise',
    table: schema.tokens,
    userColumn: schema.tokens.createdByUserId,
    reason:
      "The account's custom tokens (SC-1285). A custom token with no owner is visible to nobody, so severing the link removes it from every reader, this account included. It is not deleted: `holdings`, `vaults`, `payments`, `users.base_currency_id` and `token_prices.base_token_id` all reference `tokens` ON DELETE RESTRICT, and a row another account attached before SC-1285 would abort the whole deletion. The FK is already ON DELETE SET NULL, so the schema has decided the link is severable.",
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
    table: schema.userTwoFactors,
    userColumn: schema.userTwoFactors.userId,
    reason:
      "The account's second factor (SC-1646): a TOTP secret and its backup codes. They are part of the login, like `user_accounts`, and the flow keeps the login working. Removing them would silently turn two-factor sign-in off for an account that asked only to empty its data. Deleting the account itself still takes them, through ON DELETE CASCADE.",
  },
  {
    kind: 'keep',
    table: schema.userPasskeys,
    userColumn: schema.userPasskeys.userId,
    reason:
      "The account's passkeys (SC-1646): public keys that sign it in without an email. They are login, not portfolio content, so the flow keeps them for the same reason as `user_accounts`. Deleting the account itself still takes them, through ON DELETE CASCADE.",
  },
  {
    kind: 'anonymise',
    table: schema.tokenPriceEditHistory,
    userColumn: schema.tokenPriceEditHistory.editedByUserId,
    reason:
      "A manual price on a custom token, which is private to its owner since SC-1285 — so this is the user's own data, not a change to a shared price. The edit stays, because a price that moved with no record of the move is worse than one with no author; the author is removed. The FK is ON DELETE SET NULL since SC-1261, which is what lets `DeleteAccountUseCase` delete an account that ever priced a token.",
  },
  {
    kind: 'keep',
    table: schema.cloudApiKeys,
    userColumn: schema.cloudApiKeys.ownerUserId,
    reason:
      "The account's Scani Cloud keys, owned by `users.id` since the one-account merge. They are credentials for a separate service the account may be paying for, not portfolio content: each row is a name, a prefix and a hash. Deleting them here would silently cut off a self-hosted deployment that authenticates with them, which is revocation — something the Cloud console does per key, and a different decision from emptying the app. Deleting the account itself still takes them, through the FK's ON DELETE CASCADE.",
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
 * burn figures were amounts the user typed about their own spending, and they
 * survived a delete-everything for exactly the reason the twelve tables did —
 * nothing enumerated them. Those columns went with the Planning page (SC-1409),
 * so nothing is `clear` today; a new column holding content the user entered is
 * classified `clear`, and the classification test refuses an unclassified one.
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
    column: schema.users.twoFactorEnabled,
    reason:
      'Whether sign-in asks for a second factor (SC-1646). A property of the login, kept with `user_two_factors`; clearing it alone would leave a secret the sign-in no longer asks for.',
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

  {
    kind: 'keep',
    column: schema.users.firstExportAt,
    reason:
      'A one-bit activation marker holding no content, and NULL is defined to mean "unknown" rather than "never" — clearing it would assert something false rather than nothing.',
  },
  {
    kind: 'keep',
    column: schema.users.signupSource,
    reason:
      'Which of three fixed words described the sign-in that created the row — `demo`, `direct` or `unknown`. It holds nothing the user entered, identifies nobody (every account that ever came from the demo carries the same word), and survives the deletion the way the row it sits on does. Clearing it would move the account into the NULL bucket, which is defined as "predates the column" — asserting something false about an instrument rather than erasing something true about a person (SC-515).',
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
    column: schema.users.onboardingOptOutAt,
    reason: 'A consent record; same reasoning as `digestOptOutAt`.',
  },
  {
    kind: 'keep',
    column: schema.users.activationNudgeSentAt,
    reason:
      'The once-only guard for the activation nudge. Clearing it would mail the nudge a second time to an account that has just emptied itself (SC-1503).',
  },
  {
    kind: 'keep',
    column: schema.users.appSeenAt,
    reason:
      'When the app was last open, stamped by the session rather than typed; it holds no portfolio content, and the login that remains goes on writing it (SC-1602).',
  },
  {
    kind: 'keep',
    column: schema.users.language,
    reason:
      'A display preference for the login that remains, recorded from the sign-in rather than typed; same reasoning as `timezone` (SC-1503).',
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
