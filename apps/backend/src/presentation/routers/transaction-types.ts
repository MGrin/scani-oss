import { Container } from 'typedi';
import { TransactionTypeService } from '../../application/services/EnumServices';
import { protectedProcedure, router } from '../trpc';

export const transactionTypesRouter = router({
  // Get all transaction types
  getAll: protectedProcedure.query(async () => {
    const transactionTypeService = Container.get(TransactionTypeService);
    const transactionTypes = await transactionTypeService.getAllTypes();
    return transactionTypes;
  }),
});
