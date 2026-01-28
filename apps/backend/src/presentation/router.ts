import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { TokenValidationService } from '@scani/core/services/TokenValidationService';
import { Container } from 'typedi';
import { accountTypesRouter } from './routers/account-types';
import { accountsRouter } from './routers/accounts';
import { batchOperationsRouter } from './routers/batch-operations';
import { dashboardRouter } from './routers/dashboard';
import { groupsRouter } from './routers/groups';
import { holdingsRouter } from './routers/holdings';
import { institutionTypesRouter } from './routers/institution-types';
import { institutionsRouter } from './routers/institutions';
import { integrationsRouter } from './routers/integrations';
import { portfolioHistoryRouter } from './routers/portfolio-history';
import { screenshotsRouter } from './routers/screenshots';
import { createTokensRouter } from './routers/tokens';
import { usersRouter } from './routers/users';
import { walletRouter } from './routers/wallet';
import { publicProcedure, router } from './trpc';

// Create routers with DI
const tokensRouter = createTokensRouter(db, schema, Container.get(TokenValidationService));

export const appRouter = router({
  // User management (protected)
  users: usersRouter,

  // Dashboard (protected) - Aggregated data for overview
  dashboard: dashboardRouter,

  // Portfolio history (protected) - Historical portfolio data and events
  portfolioHistory: portfolioHistoryRouter,

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

  // Batch operations (protected) - Atomic multi-entity operations
  batchOperations: batchOperationsRouter,

  // Screenshots (protected) - AI-powered screenshot parsing
  screenshots: screenshotsRouter,

  // Wallet (protected) - Cryptocurrency wallet import
  wallet: walletRouter,

  // Integration authentication (protected) - Credential validation and storage
  integrations: integrationsRouter,

  // Health check (public)
  health: router({
    check: publicProcedure.query(() => ({
      status: 'ok',
      timestamp: new Date(),
    })),
  }),
});

export type AppRouter = typeof appRouter;
