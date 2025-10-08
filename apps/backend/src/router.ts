import { accountTypesRouter } from './routers/account-types';
import { accountsRouter } from './routers/accounts';
import { batchOperationsRouter } from './routers/batch-operations';
import { holdingsRouter } from './routers/holdings';
import { institutionTypesRouter } from './routers/institution-types';
import { institutionsRouter } from './routers/institutions';
import { screenshotParsingRouter } from './routers/screenshot-parsing';
import { tokenTypesRouter } from './routers/token-types';
import { tokenPricesRouter } from './routers/tokenPrices';
import { tokensRouter } from './routers/tokens';
import { transactionTypesRouter } from './routers/transaction-types';
import { transactionsRouter } from './routers/transactions';
import { usersRouter } from './routers/users';
import { walletRouter } from './routers/wallet';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  // User management (protected)
  users: usersRouter,

  // Core financial entities (protected)
  tokens: tokensRouter,
  tokenPrices: tokenPricesRouter,

  // Enum tables (protected)
  institutionTypes: institutionTypesRouter,
  accountTypes: accountTypesRouter,
  transactionTypes: transactionTypesRouter,
  tokenTypes: tokenTypesRouter,

  // Business entities (protected)
  institutions: institutionsRouter,
  accounts: accountsRouter,
  holdings: holdingsRouter,
  transactions: transactionsRouter,

  // Batch operations (protected) - Atomic multi-entity operations
  batchOperations: batchOperationsRouter,

  // Wallet & blockchain features (protected)
  wallet: walletRouter,

  // AI-powered features (protected)
  screenshotParsing: screenshotParsingRouter,

  // Health check (public)
  health: router({
    check: publicProcedure.query(() => ({
      status: 'ok',
      timestamp: new Date(),
    })),
  }),
});

export type AppRouter = typeof appRouter;
