import { AccountTypeRepository } from '@scani/domain/repositories';
import { Container } from 'typedi';
import { protectedProcedure, router } from '../trpc';

export const accountTypesRouter = router({
  getAll: protectedProcedure.query(async () => {
    return await Container.get(AccountTypeRepository).findAll();
  }),
});
