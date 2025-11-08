import { TokenService } from '@scani/core/services/TokenService';
import { UserService } from '@scani/core/services/UserService';
import { createComponentLogger } from '@scani/core/utils/logger';
import { UpdateUserDto } from '@scani/shared';
import { Container } from 'typedi';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const usersLogger = createComponentLogger('router:users');

const userService = Container.get(UserService);
const tokenService = Container.get(TokenService);

export const usersRouter = router({
  // Get current authenticated user
  // KEEP
  getCurrent: protectedProcedure.query(async ({ ctx }) => {
    // Use cached user data from auth context instead of querying database
    const { dbUser } = requireAuth(ctx);
    return dbUser;
  }),

  // Update current user
  // KEEP
  updateCurrent: protectedProcedure.input(UpdateUserDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);

    const updatedUser = await userService.updateUser(dbUser.id, input);

    if (!updatedUser) {
      throw new Error('User not found');
    }

    return updatedUser;
  }),

  // Get supported fiat currencies (tokens) for base currency selection
  // Keep
  getSupportedCurrencies: protectedProcedure.query(async () => {
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
  // KEEP
  getBaseCurrency: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);

    if (!dbUser.baseCurrencyId) {
      return null;
    }

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
});
