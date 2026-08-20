import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { accountTypesRouter } from './routers/account-types';
import { accountsRouter } from './routers/accounts';
import { batchOperationsRouter } from './routers/batch-operations';
import { clientErrorsRouter } from './routers/client-errors';
import { dashboardRouter } from './routers/dashboard';
import { documentsRouter } from './routers/documents';
import { exportsRouter } from './routers/exports';
import { fileImportRouter } from './routers/file-import';
import { groupsRouter } from './routers/groups';
import { holdingsRouter } from './routers/holdings';
import { institutionTypesRouter } from './routers/institution-types';
import { institutionsRouter } from './routers/institutions';
import { integrationsRouter } from './routers/integrations';
import { jobsRouter } from './routers/jobs';
import { paymentsRouter } from './routers/payments';
import { portfolioRouter } from './routers/portfolio';
import { pushRouter } from './routers/push';
import { reviewRouter } from './routers/review';
import { screenshotsRouter } from './routers/screenshots';
import { sessionsRouter } from './routers/sessions';
import { storageRouter } from './routers/storage';
import { createTokensRouter } from './routers/tokens';
import { transactionsRouter } from './routers/transactions';
import { transferReviewRouter } from './routers/transfer-review';
import { usersRouter } from './routers/users';
import { vaultsRouter } from './routers/vaults';
import { vendorsRouter } from './routers/vendors';
import { walletRouter } from './routers/wallet';
import { publicProcedure, router } from './trpc';

const tokensRouter = createTokensRouter(db, schema);

export const appRouter = router({
  // User management (protected)
  users: usersRouter,

  // Dashboard (protected) - Aggregated data for overview
  dashboard: dashboardRouter,

  // Portfolio history (protected) - Net-worth-over-time + coverage metadata
  portfolio: portfolioRouter,

  // Manual transaction entry (protected) - power-user CRUD over holding_transactions
  transactions: transactionsRouter,

  // Whole-account export (protected) - one snapshot of everything the user owns
  exports: exportsRouter,

  // Core financial entities (protected)
  tokens: tokensRouter,

  // Enum tables (protected)
  institutionTypes: institutionTypesRouter,
  accountTypes: accountTypesRouter,

  // Business entities (protected)
  institutions: institutionsRouter,
  accounts: accountsRouter,
  holdings: holdingsRouter,
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
  transferReview: transferReviewRouter,

  storage: storageRouter,

  // Active session management (protected) - list/revoke for the
  // signed-in user, backing the Settings → Devices section.
  sessions: sessionsRouter,

  // Web Push subscriptions (protected) - one row per browser per device,
  // consumed by the payment-due reminder on the worker (SC-226).
  push: pushRouter,

  // Health check (public)
  health: router({
    check: publicProcedure.query(() => ({
      status: 'ok',
      timestamp: new Date(),
    })),
  }),
});

export type AppRouter = typeof appRouter;
