import { accountsRouter } from './routers/accounts';
import { holdingsRouter } from './routers/holdings';
import { institutionTypesRouter } from './routers/institution-types';
import { institutionsRouter } from './routers/institutions';
import { tokenPricesRouter } from './routers/tokenPrices';
import { tokensRouter } from './routers/tokens';
import { transactionsRouter } from './routers/transactions';
import { usersRouter } from './routers/users';
import { publicProcedure, router } from './trpc';

export const appRouter = router({
  // User management
  users: usersRouter,

  // Core financial entities
  tokens: tokensRouter,
  tokenPrices: tokenPricesRouter,
  institutionTypes: institutionTypesRouter,
  institutions: institutionsRouter,
  accounts: accountsRouter,
  holdings: holdingsRouter,
  transactions: transactionsRouter,

  // Health check
  health: router({
    check: publicProcedure.query(() => ({
      status: 'ok',
      timestamp: new Date(),
    })),
  }),
});

export type AppRouter = typeof appRouter;
