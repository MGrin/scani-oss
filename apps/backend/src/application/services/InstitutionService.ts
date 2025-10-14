import { Container, Service } from 'typedi';
import type { CreateInstitutionInput, UpdateInstitutionInput } from '../../domain/dtos/institution';
import type { Institution } from '../../domain/entities';
import { InstitutionTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { BaseService } from './BaseService';

@Service()
export class InstitutionService extends BaseService {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly institutionTypeRepository = Container.get(InstitutionTypeRepository);

  constructor() {
    super('InstitutionService');
  }

  async createInstitution(data: CreateInstitutionInput, userId: string): Promise<Institution> {
    try {
      this.logInfo('Creating institution', { name: data.name, userId });

      this.validateRequiredFields(data, ['name', 'typeCode']);
      this.validateNonEmptyString(data.name, 'name');

      // Validate institution type exists
      const institutionType = await this.institutionTypeRepository.findByCode(data.typeCode);
      this.assertExists(institutionType, `Institution type with code ${data.typeCode} not found`);

      const institution = await this.institutionRepository.create({
        name: data.name,
        typeId: institutionType.id,
        description: data.description || null,
        website: data.website || null,
        logoUrl: data.logoUrl || null,
        isActive: true,
      });

      this.logInfo('Institution created', { institutionId: institution.id });
      return institution;
    } catch (error) {
      throw this.handleError(error, 'createInstitution');
    }
  }

  async updateInstitution(
    institutionId: string,
    data: UpdateInstitutionInput,
    _userId: string
  ): Promise<Institution> {
    try {
      this.logInfo('Updating institution', { institutionId, data });

      const existing = await this.institutionRepository.findById(institutionId);
      this.assertExists(existing, `Institution with ID ${institutionId} not found`);

      // Validate type if provided
      let typeId = existing.typeId;
      if (data.typeCode) {
        const institutionType = await this.institutionTypeRepository.findByCode(data.typeCode);
        this.assertExists(institutionType, `Institution type with code ${data.typeCode} not found`);
        typeId = institutionType.id;
      }

      const updated = await this.institutionRepository.update(institutionId, {
        ...(data.name && { name: data.name }),
        ...(data.typeCode && { typeId }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.website !== undefined && { website: data.website }),
        ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      });
      this.assertExists(updated, 'Failed to update institution');

      this.logInfo('Institution updated', { institutionId });
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateInstitution');
    }
  }

  async getInstitutionById(institutionId: string, _userId: string): Promise<Institution> {
    try {
      const institution = await this.institutionRepository.findById(institutionId);
      this.assertExists(institution, `Institution with ID ${institutionId} not found`);

      return institution;
    } catch (error) {
      throw this.handleError(error, 'getInstitutionById');
    }
  }

  async getInstitutionsByUserId(userId: string): Promise<Institution[]> {
    try {
      return await this.institutionRepository.findByUserId(userId);
    } catch (error) {
      throw this.handleError(error, 'getInstitutionsByUserId');
    }
  }

  async getInstitutionWithAccounts(institutionId: string, userId: string) {
    try {
      const institution = await this.institutionRepository.findWithAccounts(institutionId, userId);
      this.assertExists(institution, `Institution with ID ${institutionId} not found`);

      return institution;
    } catch (error) {
      throw this.handleError(error, 'getInstitutionWithAccounts');
    }
  }

  async deleteInstitution(institutionId: string, _userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting institution', { institutionId });

      const existing = await this.institutionRepository.findById(institutionId);
      this.assertExists(existing, `Institution with ID ${institutionId} not found`);

      const deleted = await this.institutionRepository.delete(institutionId);
      this.logInfo('Institution deleted', { institutionId, deleted });
      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteInstitution');
    }
  }
}
