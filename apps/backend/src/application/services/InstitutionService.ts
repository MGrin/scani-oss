import type { CreateInstitutionInput } from '@scani/shared';
import { Container, Service } from 'typedi';
import type { Institution } from '../../domain/entities';
import type { DatabaseTransaction } from '../../infrastructure/repositories/BaseRepository';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { BaseService } from './BaseService';

@Service()
export class InstitutionService extends BaseService {
  private readonly institutionRepository = Container.get(InstitutionRepository);

  constructor() {
    super('InstitutionService');
  }

  async createInstitution(
    data: CreateInstitutionInput,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Institution> {
    try {
      this.logInfo('Creating institution', { name: data.name, userId });

      this.validateRequiredFields(data, ['name', 'typeId']);
      this.validateNonEmptyString(data.name, 'name');

      const institution = await this.institutionRepository.create(
        {
          name: data.name,
          typeId: data.typeId,
          description: data.description || null,
          website: data.website || null,
          logoUrl: data.logoUrl || null,
          isActive: true,
        },
        tx
      );

      this.logInfo('Institution created', { institutionId: institution.id });
      return institution;
    } catch (error) {
      throw this.handleError(error, 'createInstitution');
    }
  }
}
