import { UpdateUserSchema } from '@scani/shared/types';
import { Container } from 'typedi';
import { PortfolioValuationService } from '../../application/services/PortfolioValuationService';
import { TokenService } from '../../application/services/TokenService';
import { UserService } from '../../application/services/UserService';
import { getUserId, requireAuth } from '../../middleware/auth';
import { createComponentLogger } from '../../utils/logger';
import { protectedProcedure, router } from '../trpc';

const usersLogger = createComponentLogger('router:users');

export const usersRouter = router({
  // Get current authenticated user
  getCurrent: protectedProcedure.query(async ({ ctx }) => {
    // Use cached user data from auth context instead of querying database
    const { dbUser } = requireAuth(ctx);
    return dbUser;
  }),

  // Update current user
  updateCurrent: protectedProcedure.input(UpdateUserSchema).mutation(async ({ input, ctx }) => {
    const userId = getUserId(ctx);
    const userService = Container.get(UserService);

    const updatedUser = await userService.updateUser(userId, input);

    if (!updatedUser) {
      throw new Error('User not found');
    }

    return updatedUser;
  }),

  // Get supported fiat currencies (tokens) for base currency selection
  getSupportedCurrencies: protectedProcedure.query(async () => {
    const tokenService = Container.get(TokenService);

    usersLogger.debug('Fetching supported fiat currencies');
    const fiatTokens = await tokenService.getTokensByType('fiat');
    usersLogger.debug({ count: fiatTokens.length }, 'Fetched fiat tokens');

    return fiatTokens.map((token) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
    }));
  }),

  // Get user's base currency token (lightweight)
  getBaseCurrency: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);

    if (!dbUser.baseCurrencyId) {
      return null;
    }

    const tokenService = Container.get(TokenService);
    const baseCurrency = await tokenService.getTokenById(dbUser.baseCurrencyId);

    if (!baseCurrency) {
      return null;
    }

    return {
      id: baseCurrency.id,
      symbol: baseCurrency.symbol,
      name: baseCurrency.name,
    };
  }),

  // Get current portfolio value
  getPortfolioValue: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const portfolioService = Container.get(PortfolioValuationService);

    try {
      // Pass user's base currency ID to avoid extra database query
      return await portfolioService.getUserPortfolioValue(
        dbUser.id,
        dbUser.baseCurrencyId || undefined
      );
    } catch (error) {
      // If error occurs (e.g., no base currency), return empty portfolio
      usersLogger.warn(
        {
          userId: dbUser.id,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to get portfolio value for user'
      );
      return {
        totalValue: '0',
        baseCurrency: 'USD',
        holdings: [],
      };
    }
  }),
});
