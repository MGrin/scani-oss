import { Container, Service } from 'typedi';
import type { CreateAccountInput, UpdateAccountInput } from '../../domain/dtos/account';
import type { Account } from '../../domain/entities';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import { AccountTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { BaseService } from './BaseService';

@Service()
export class AccountService extends BaseService {
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly accountTypeRepository = Container.get(AccountTypeRepository);
  private readonly institutionRepository = Container.get(InstitutionRepository);

  constructor() {
    super('AccountService');
  }

  async createAccount(data: CreateAccountInput, userId: string): Promise<Account> {
    try {
      this.logInfo('Creating account', { name: data.name, institutionId: data.institutionId });

      this.validateRequiredFields(data, ['name', 'typeCode', 'institutionId']);
      this.validateNonEmptyString(data.name, 'name');

      // Validate account type exists
      const accountType = await this.accountTypeRepository.findByCode(data.typeCode);
      this.assertExists(accountType, `Account type with code ${data.typeCode} not found`);

      // Validate institution exists and belongs to user
      const institution = await this.institutionRepository.findById(data.institutionId);
      this.assertExists(institution, `Institution with ID ${data.institutionId} not found`);

      const account = await this.accountRepository.create({
        name: data.name,
        typeId: accountType.id,
        institutionId: data.institutionId,
        userId,
        description: data.description || null,
        metadata: (data.metadata as Record<string, unknown>) || {},
        isActive: true,
      });

      this.logInfo('Account created', { accountId: account.id });
      return account;
    } catch (error) {
      throw this.handleError(error, 'createAccount');
    }
  }

  async updateAccount(
    accountId: string,
    data: UpdateAccountInput,
    _userId: string
  ): Promise<Account> {
    try {
      this.logInfo('Updating account', { accountId, data });

      const existing = await this.accountRepository.findById(accountId);
      this.assertExists(existing, `Account with ID ${accountId} not found`);

      // Validate type if provided
      let typeId = existing.typeId;
      if (data.typeCode) {
        const accountType = await this.accountTypeRepository.findByCode(data.typeCode);
        this.assertExists(accountType, `Account type with code ${data.typeCode} not found`);
        typeId = accountType.id;
      }

      const updated = await this.accountRepository.update(accountId, {
        ...(data.name && { name: data.name }),
        ...(data.typeCode && { typeId }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.metadata && { metadata: data.metadata as Record<string, unknown> }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      });
      this.assertExists(updated, 'Failed to update account');

      this.logInfo('Account updated', { accountId });
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateAccount');
    }
  }

  async getAccountById(accountId: string, _userId: string): Promise<Account> {
    try {
      const account = await this.accountRepository.findById(accountId);
      this.assertExists(account, `Account with ID ${accountId} not found`);

      return account;
    } catch (error) {
      throw this.handleError(error, 'getAccountById');
    }
  }

  async getAccountsByUserId(userId: string): Promise<Account[]> {
    try {
      return await this.accountRepository.findByUser(userId);
    } catch (error) {
      throw this.handleError(error, 'getAccountsByUserId');
    }
  }

  async getAccountsByInstitution(institutionId: string, userId: string): Promise<Account[]> {
    try {
      // Verify institution ownership
      const institution = await this.institutionRepository.findById(institutionId);
      this.assertExists(institution, `Institution with ID ${institutionId} not found`);

      return await this.accountRepository.findByInstitution(institutionId, userId);
    } catch (error) {
      throw this.handleError(error, 'getAccountsByInstitution');
    }
  }

  async getAccountWithHoldings(accountId: string, userId: string) {
    try {
      const account = await this.accountRepository.findWithHoldings(accountId, userId);

      return account;
    } catch (error) {
      throw this.handleError(error, 'getAccountWithHoldings');
    }
  }

  async deleteAccount(accountId: string, _userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting account', { accountId });

      const existing = await this.accountRepository.findById(accountId);
      this.assertExists(existing, `Account with ID ${accountId} not found`);

      const deleted = await this.accountRepository.delete(accountId);
      this.logInfo('Account deleted', { accountId, deleted });
      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteAccount');
    }
  }
}
