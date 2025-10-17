import { Container } from 'typedi';
import { AccountTypeService } from '../../application/services/EnumServices';
import { protectedProcedure, router } from '../trpc';

const accountTypeService = Container.get(AccountTypeService);

export const accountTypesRouter = router({
  getAll: protectedProcedure.query(async () => {
    const accountTypes = await accountTypeService.getAllTypes();
    return accountTypes;
  }),
});
