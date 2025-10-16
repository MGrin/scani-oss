import { Container } from 'typedi';
import { AccountTypeService } from '../../application/services/EnumServices';
import { protectedProcedure, router } from '../trpc';

export const accountTypesRouter = router({
  // Get all account types
  getAll: protectedProcedure.query(async () => {
    const accountTypeService = Container.get(AccountTypeService);
    const accountTypes = await accountTypeService.getAllTypes();
    return accountTypes;
  }),
});
