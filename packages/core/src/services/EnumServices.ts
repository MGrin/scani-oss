import { Container, Service } from 'typedi';
import type { AccountType, InstitutionType } from '../domain/entities';
import { AccountTypeRepository, InstitutionTypeRepository } from '../repositories/EnumRepositories';
import { BaseService } from './BaseService';

@Service()
export class InstitutionTypeService extends BaseService {
  private readonly institutionTypeRepository = Container.get(InstitutionTypeRepository);

  constructor() {
    super('InstitutionTypeService');
  }

  async getAllTypes(): Promise<InstitutionType[]> {
    try {
      return await this.institutionTypeRepository.findAll();
    } catch (error) {
      throw this.handleError(error, 'getAllTypes');
    }
  }
}

@Service()
export class AccountTypeService extends BaseService {
  private readonly accountTypeRepository = Container.get(AccountTypeRepository);

  constructor() {
    super('AccountTypeService');
  }

  async getAllTypes(): Promise<AccountType[]> {
    try {
      return await this.accountTypeRepository.findAll();
    } catch (error) {
      throw this.handleError(error, 'getAllTypes');
    }
  }
}
