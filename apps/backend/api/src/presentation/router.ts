import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { accountTypesRouter } from './routers/account-types';
import { accountsRouter } from './routers/accounts';
import { agentTokensRouter } from './routers/agent-tokens';
import { backupsRouter } from './routers/backups';
import { balanceGapsRouter } from './routers/balance-gaps';
import { batchOperationsRouter } from './routers/batch-operations';
import { billCalendarRouter } from './routers/bill-calendar';
import { budgetAppImportsRouter } from './routers/budget-app-imports';
import { categoriesRouter } from './routers/categories';
import { clientErrorsRouter } from './routers/client-errors';
import { dashboardRouter } from './routers/dashboard';
import { demoRouter } from './routers/demo';
import { documentsRouter } from './routers/documents';
import { entitiesRouter } from './routers/entities';
import { exportsRouter } from './routers/exports';
import { fileImportRouter } from './routers/file-import';
import { groupsRouter } from './routers/groups';
import { holdingsRouter } from './routers/holdings';
import { householdRouter } from './routers/household';
import { institutionTypesRouter } from './routers/institution-types';
import { institutionsRouter } from './routers/institutions';
import { integrationsRouter } from './routers/integrations';
import { jobsRouter } from './routers/jobs';
import { liabilitiesRouter } from './routers/liabilities';
import { paymentsRouter } from './routers/payments';
import { portfolioRouter } from './routers/portfolio';
import { pushRouter } from './routers/push';
import { reviewRouter } from './routers/review';
import { screenshotsRouter } from './routers/screenshots';
import { sessionsRouter } from './routers/sessions';
import { settlementAnswersRouter } from './routers/settlement-answers';
import { storageRouter } from './routers/storage';
import { createTokensRouter } from './routers/tokens';
import { transactionsRouter } from './routers/transactions';
import { transferReviewRouter } from './routers/transfer-review';
import { transitReviewRouter } from './routers/transit-review';
import { untrackedArrivalReviewRouter } from './routers/untracked-arrival-review';
import { usersRouter } from './routers/users';
import { valuedAssetsRouter } from './routers/valued-assets';
import { vaultsRouter } from './routers/vaults';
import { vendorsRouter } from './routers/vendors';
import { walletRouter } from './routers/wallet';
import { router } from './trpc';

const tokensRouter = createTokensRouter(db, schema);

export const appRouter = router({
  // Demo posture (public) — whether this deployment is the read-only demo.
  // Answered before the app asks for a session, so it must not need one.
  demo: demoRouter,

  // User management (protected)
  users: usersRouter,
  valuedAssets: valuedAssetsRouter,

  // Dashboard (protected) - Aggregated data for overview
  dashboard: dashboardRouter,

  // Portfolio history (protected) - Net-worth-over-time + coverage metadata
  portfolio: portfolioRouter,

  // Manual transaction entry (protected) - power-user CRUD over holding_transactions
  categories: categoriesRouter,
  transactions: transactionsRouter,

  // Whole-account export (protected) - one snapshot of everything the user owns
  backups: backupsRouter,
  household: householdRouter,
  budgetAppImports: budgetAppImportsRouter,
  exports: exportsRouter,

  // Core financial entities (protected)
  tokens: tokensRouter,

  // Personal access tokens for the user's own AI agent (protected, flag-gated)
  agentTokens: agentTokensRouter,

  // Enum tables (protected)
  institutionTypes: institutionTypesRouter,
  accountTypes: accountTypesRouter,
  liabilities: liabilitiesRouter,

  // Business entities (protected)
  institutions: institutionsRouter,
  accounts: accountsRouter,
  holdings: holdingsRouter,
  entities: entitiesRouter,
  groups: groupsRouter,

  // Vaults (protected) - Savings goals with attached holdings
  vaults: vaultsRouter,

  // Batch operations (protected) - Atomic multi-entity operations
  batchOperations: batchOperationsRouter,

  // Screenshots (protected) - AI-powered screenshot parsing
  screenshots: screenshotsRouter,

  // Wallet (protected) - Cryptocurrency wallet import
  wallet: walletRouter,

  // Integration authentication (protected) - Credential validation and storage
  integrations: integrationsRouter,

  // File import (protected) - Bank statement parsing (CSV, OFX)
  fileImport: fileImportRouter,

  // Payments (protected) - Recurring bills/income, occurrences, manual settlement
  payments: paymentsRouter,
  // The opt-in bills calendar feed's URL (protected) - SC-1654
  billCalendar: billCalendarRouter,

  // Vendors (protected) - Who a user pays or is paid by; alias merge
  vendors: vendorsRouter,

  // Documents (protected) - Invoice/receipt upload → AI extraction review queue
  documents: documentsRouter,

  // Client error reporting (public) - V2 ErrorBoundary posts here
  clientErrors: clientErrorsRouter,

  // Background job status + uploads
  jobs: jobsRouter,

  // Review feed (read-model of pending items)
  review: reviewRouter,

  // Unpaired transfers awaiting a human decision (SC-150). Separate from
  // `review` because this one writes.
  balanceGaps: balanceGapsRouter,
  // Answers imported trade settlements now explain: retire, keep, undo (SC-1453).
  settlementAnswers: settlementAnswersRouter,
  transitReview: transitReviewRouter,
  transferReview: transferReviewRouter,
  // "Was this the transfer to <account>?" about an untracked answer (SC-1696).
  untrackedArrivalReview: untrackedArrivalReviewRouter,

  storage: storageRouter,

  // Active session management (protected) - list/revoke for the
  // signed-in user, backing the Settings → Devices section.
  sessions: sessionsRouter,

  // Web Push subscriptions (protected) - one row per browser per device,
  // consumed by the payment-due reminder on the worker (SC-226).
  push: pushRouter,
});

export type AppRouter = typeof appRouter;
