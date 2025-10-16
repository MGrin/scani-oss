import { Container } from 'typedi';
import { TokenTypeService } from '../../application/services/EnumServices';
import { protectedProcedure, router } from '../trpc';

export const tokenTypesRouter = router({
  // Get all token types
  getAll: protectedProcedure.query(async () => {
    const tokenTypeService = Container.get(TokenTypeService);
    const tokenTypes = await tokenTypeService.getAllTypes();
    return tokenTypes;
  }),
});
