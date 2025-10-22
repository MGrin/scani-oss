import { Container } from 'typedi';
import { TokenValidationService } from '../../application/services/TokenValidationService';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { publicProcedure, router } from '../trpc';
import { accountTypesRouter } from './account-types';
import { accountsRouter } from './accounts';
import { batchOperationsRouter } from './batch-operations';
import { dashboardRouter } from './dashboard';
import { holdingsRouter } from './holdings';
import { institutionTypesRouter } from './institution-types';
import { institutionsRouter } from './institutions';
import { screenshotsRouter } from './screenshots';
import { createTokensRouter } from './tokens';
import { usersRouter } from './users';

// Create routers with DI
const tokensRouter = createTokensRouter(db, schema, Container.get(TokenValidationService));

export const appRouter = router({
  // User management (protected)
  users: usersRouter,

  // Dashboard (protected) - Aggregated data for overview
  dashboard: dashboardRouter,

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

  // Batch operations (protected) - Atomic multi-entity operations
  batchOperations: batchOperationsRouter,

  // Health check (public)
  health: router({
    check: publicProcedure.query(() => ({
      status: 'ok',
      timestamp: new Date(),
    })),
  }),
});

export type AppRouter = typeof appRouter;
