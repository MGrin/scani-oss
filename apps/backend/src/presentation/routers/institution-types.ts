import { Container } from 'typedi';
import { InstitutionTypeService } from '../../application/services/EnumServices';
import { publicProcedure, router } from '../trpc';

const institutionTypeService = Container.get(InstitutionTypeService);

export const institutionTypesRouter = router({
  /**
   * Get all active institution types for UI dropdowns
   */
  // KEEP
  getAll: publicProcedure.query(async () => {
    const types = await institutionTypeService.getAllTypes();

    return types.map((type) => ({
      id: type.id,
      code: type.code,
      name: type.name,
      description: type.description,
      displayOrder: type.displayOrder,
    }));
  }),
});
