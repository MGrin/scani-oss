import { InstitutionTypeRepository } from '@scani/domain/repositories';
import { Container } from 'typedi';
import { publicProcedure, router } from '../trpc';

export const institutionTypesRouter = router({
  /**
   * Get all active institution types for UI dropdowns
   */
  getAll: publicProcedure.query(async () => {
    const types = await Container.get(InstitutionTypeRepository).findAll();

    return types.map((type) => ({
      id: type.id,
      code: type.code,
      name: type.name,
      description: type.description,
      displayOrder: type.displayOrder,
    }));
  }),
});
