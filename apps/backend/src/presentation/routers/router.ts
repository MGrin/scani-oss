import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { TokenValidationService } from '@scani/core/services/TokenValidationService';
import { Container } from 'typedi';
import { publicProcedure, router } from '../trpc';
import { accountTypesRouter } from './account-types';
import { accountsRouter } from './accounts';
import { batchOperationsRouter } from './batch-operations';
import { dashboardRouter } from './dashboard';
import { holdingsRouter } from './holdings';
import { institutionTypesRouter } from './institution-types';
import { institutionsRouter } from './institutions';
import { integrationsRouter } from './integrations';
import { portfolioHistoryRouter } from './portfolio-history';
import { screenshotsRouter } from './screenshots';
import { createTokensRouter } from './tokens';
import { usersRouter } from './users';
import { vaultsRouter } from './vaults';
import { walletRouter } from './wallet';

// Create routers with DI
const tokensRouter = createTokensRouter(db, schema, Container.get(TokenValidationService));

export const appRouter = router({
  // User management (protected)
  users: usersRouter,

  // Dashboard (protected) - Aggregated data for overview
  dashboard: dashboardRouter,

  // Portfolio history (protected) - Historical portfolio tracking
  portfolioHistory: portfolioHistoryRouter,

  // Core financial entities (protected)
  tokens: tokensRouter,

  // AI-powered screenshot parsing (protected)
  screenshots: screenshotsRouter,

  // Enum tables (protected)
  institutionTypes: institutionTypesRouter,
  accountTypes: accountTypesRouter,

  // Business entities (protected)
  institutions: institutionsRouter,
  accounts: accountsRouter,
  holdings: holdingsRouter,

  // Vaults (protected) - Savings goals with attached holdings
  vaults: vaultsRouter,

  // Batch operations (protected) - Atomic multi-entity operations
  batchOperations: batchOperationsRouter,

  // Wallet import (protected) - Multi-chain crypto wallet import
  wallet: walletRouter,

  // Integration authentication (protected) - API key validation and storage
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
