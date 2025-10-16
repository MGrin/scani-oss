import { Container, Service } from 'typedi';
import type {
  AccountType,
  InstitutionType,
  TokenType,
  TransactionType,
} from '../../domain/entities';
import {
  AccountTypeRepository,
  InstitutionTypeRepository,
  TokenTypeRepository,
  TransactionTypeRepository,
} from '../../infrastructure/repositories/EnumRepositories';
import { BaseService } from './BaseService';

// =============================================================================
// InstitutionTypeService
// =============================================================================

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

  async getActiveTypes(): Promise<InstitutionType[]> {
    try {
      return await this.institutionTypeRepository.findActive();
    } catch (error) {
      throw this.handleError(error, 'getActiveTypes');
    }
  }

  async getTypeByCode(code: string): Promise<InstitutionType | null> {
    try {
      this.validateNonEmptyString(code, 'code');
      return await this.institutionTypeRepository.findByCode(code);
    } catch (error) {
      throw this.handleError(error, 'getTypeByCode');
    }
  }

  async getTypeById(id: string): Promise<InstitutionType | null> {
    try {
      return await this.institutionTypeRepository.findById(id);
    } catch (error) {
      throw this.handleError(error, 'getTypeById');
    }
  }

  async validateType(code: string): Promise<boolean> {
    try {
      const type = await this.getTypeByCode(code);
      return type?.isActive ?? false;
    } catch (error) {
      throw this.handleError(error, 'validateType');
    }
  }
}

// =============================================================================
// AccountTypeService
// =============================================================================

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

  async getActiveTypes(): Promise<AccountType[]> {
    try {
      return await this.accountTypeRepository.findActive();
    } catch (error) {
      throw this.handleError(error, 'getActiveTypes');
    }
  }

  async getTypeByCode(code: string): Promise<AccountType | null> {
    try {
      this.validateNonEmptyString(code, 'code');
      return await this.accountTypeRepository.findByCode(code);
    } catch (error) {
      throw this.handleError(error, 'getTypeByCode');
    }
  }

  async getTypeById(id: string): Promise<AccountType | null> {
    try {
      return await this.accountTypeRepository.findById(id);
    } catch (error) {
      throw this.handleError(error, 'getTypeById');
    }
  }

  async validateType(code: string): Promise<boolean> {
    try {
      const type = await this.getTypeByCode(code);
      return type?.isActive ?? false;
    } catch (error) {
      throw this.handleError(error, 'validateType');
    }
  }
}

// =============================================================================
// TransactionTypeService
// =============================================================================

@Service()
export class TransactionTypeService extends BaseService {
  private readonly transactionTypeRepository = Container.get(TransactionTypeRepository);

  constructor() {
    super('TransactionTypeService');
  }

  async getAllTypes(): Promise<TransactionType[]> {
    try {
      return await this.transactionTypeRepository.findAll();
    } catch (error) {
      throw this.handleError(error, 'getAllTypes');
    }
  }

  async getActiveTypes(): Promise<TransactionType[]> {
    try {
      return await this.transactionTypeRepository.findActive();
    } catch (error) {
      throw this.handleError(error, 'getActiveTypes');
    }
  }

  async getTypeByCode(code: string): Promise<TransactionType | null> {
    try {
      this.validateNonEmptyString(code, 'code');
      return await this.transactionTypeRepository.findByCode(code);
    } catch (error) {
      throw this.handleError(error, 'getTypeByCode');
    }
  }

  async getTypeById(id: string): Promise<TransactionType | null> {
    try {
      return await this.transactionTypeRepository.findById(id);
    } catch (error) {
      throw this.handleError(error, 'getTypeById');
    }
  }

  async validateType(code: string): Promise<boolean> {
    try {
      const type = await this.getTypeByCode(code);
      return type?.isActive ?? false;
    } catch (error) {
      throw this.handleError(error, 'validateType');
    }
  }
}

// =============================================================================
// TokenTypeService
// =============================================================================

@Service()
export class TokenTypeService extends BaseService {
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

  constructor() {
    super('TokenTypeService');
  }

  async getAllTypes(): Promise<TokenType[]> {
    try {
      return await this.tokenTypeRepository.findAll();
    } catch (error) {
      throw this.handleError(error, 'getAllTypes');
    }
  }

  async getActiveTypes(): Promise<TokenType[]> {
    try {
      return await this.tokenTypeRepository.findActive();
    } catch (error) {
      throw this.handleError(error, 'getActiveTypes');
    }
  }

  async getTypeByCode(code: string): Promise<TokenType | null> {
    try {
      this.validateNonEmptyString(code, 'code');
      return await this.tokenTypeRepository.findByCode(code);
    } catch (error) {
      throw this.handleError(error, 'getTypeByCode');
    }
  }

  async getTypeById(id: string): Promise<TokenType | null> {
    try {
      return await this.tokenTypeRepository.findById(id);
    } catch (error) {
      throw this.handleError(error, 'getTypeById');
    }
  }

  async validateType(code: string): Promise<boolean> {
    try {
      const type = await this.getTypeByCode(code);
      return type?.isActive ?? false;
    } catch (error) {
      throw this.handleError(error, 'validateType');
    }
  }
}
