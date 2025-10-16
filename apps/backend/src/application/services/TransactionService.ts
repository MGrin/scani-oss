import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { CreateTransactionInput, UpdateTransactionInput } from '../../domain/dtos/transaction';
import type { Transaction } from '../../domain/entities';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import { TransactionTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { TransactionRepository } from '../../infrastructure/repositories/TransactionRepository';
import { BaseService } from './BaseService';

@Service()
export class TransactionService extends BaseService {
  private readonly transactionRepository = Container.get(TransactionRepository);
  private readonly transactionTypeRepository = Container.get(TransactionTypeRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);

  constructor() {
    super('TransactionService');
  }

  async createTransaction(data: CreateTransactionInput, userId: string): Promise<Transaction> {
    try {
      this.logInfo('Creating transaction', {
        holdingId: data.holdingId,
        typeCode: data.typeCode,
        amount: data.amount,
      });

      this.validateRequiredFields(data, ['holdingId', 'typeCode', 'amount', 'timestamp']);

      // Validate transaction type exists
      const transactionType = await this.transactionTypeRepository.findByCode(data.typeCode);
      this.assertExists(transactionType, `Transaction type with code ${data.typeCode} not found`);

      // Verify holding exists and belongs to user
      const holding = await this.holdingRepository.findById(data.holdingId);
      this.assertExists(holding, `Holding with ID ${data.holdingId} not found`);

      const account = await this.accountRepository.findById(holding.accountId);
      this.assertExists(account, `Account not found for holding ${data.holdingId}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }

      // Validate amount
      const amount = new Decimal(data.amount);
      if (amount.isZero()) {
        throw new Error('Transaction amount cannot be zero');
      }

      const transaction = await this.transactionRepository.create({
        holdingId: data.holdingId,
        typeId: transactionType.id,
        userId,
        amount: data.amount,
        fee: data.fee || '0',
        feeTokenId: data.feeTokenId || null,
        timestamp: data.timestamp,
        description: data.description || null,
        reference: data.reference || null,
      });

      this.logInfo('Transaction created', { transactionId: transaction.id });
      return transaction;
    } catch (error) {
      throw this.handleError(error, 'createTransaction');
    }
  }

  async updateTransaction(
    transactionId: string,
    data: UpdateTransactionInput,
    userId: string
  ): Promise<Transaction> {
    try {
      this.logInfo('Updating transaction', { transactionId, data });

      const existing = await this.transactionRepository.findById(transactionId);
      this.assertExists(existing, `Transaction with ID ${transactionId} not found`);

      // Verify ownership
      const holding = await this.holdingRepository.findById(existing.holdingId);
      this.assertExists(holding, `Holding not found for transaction ${transactionId}`);

      const account = await this.accountRepository.findById(holding.accountId);
      this.assertExists(account, `Account not found for holding ${holding.id}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Transaction does not belong to user');
      }

      // Validate type if provided
      let typeId = existing.typeId;
      if (data.typeCode) {
        const transactionType = await this.transactionTypeRepository.findByCode(data.typeCode);
        this.assertExists(transactionType, `Transaction type with code ${data.typeCode} not found`);
        typeId = transactionType.id;
      }

      // Validate amount if provided
      if (data.amount !== undefined) {
        const amount = new Decimal(data.amount);
        if (amount.isZero()) {
          throw new Error('Transaction amount cannot be zero');
        }
      }

      const updated = await this.transactionRepository.update(transactionId, {
        ...(data.typeCode && { typeId }),
        ...(data.amount !== undefined && { amount: data.amount }),
        ...(data.fee !== undefined && { fee: data.fee }),
        ...(data.feeTokenId !== undefined && { feeTokenId: data.feeTokenId }),
        ...(data.timestamp && { timestamp: data.timestamp }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.reference !== undefined && { reference: data.reference }),
      });
      this.assertExists(updated, 'Failed to update transaction');

      this.logInfo('Transaction updated', { transactionId });
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateTransaction');
    }
  }

  async getTransactionById(transactionId: string, userId: string): Promise<Transaction> {
    try {
      const transaction = await this.transactionRepository.findById(transactionId);
      this.assertExists(transaction, `Transaction with ID ${transactionId} not found`);

      // Verify ownership
      const holding = await this.holdingRepository.findById(transaction.holdingId);
      this.assertExists(holding, `Holding not found for transaction ${transactionId}`);

      const account = await this.accountRepository.findById(holding.accountId);
      this.assertExists(account, `Account not found for holding ${holding.id}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Transaction does not belong to user');
      }

      return transaction;
    } catch (error) {
      throw this.handleError(error, 'getTransactionById');
    }
  }

  async getTransactionsByHolding(holdingId: string, userId: string): Promise<Transaction[]> {
    try {
      // Verify holding ownership
      const holding = await this.holdingRepository.findById(holdingId);
      this.assertExists(holding, `Holding with ID ${holdingId} not found`);

      const account = await this.accountRepository.findById(holding.accountId);
      this.assertExists(account, `Account not found for holding ${holdingId}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }

      return await this.transactionRepository.findByHolding(holdingId);
    } catch (error) {
      throw this.handleError(error, 'getTransactionsByHolding');
    }
  }

  async getTransactionsByAccount(accountId: string, userId: string): Promise<Transaction[]> {
    try {
      // Verify account ownership
      const account = await this.accountRepository.findById(accountId);
      this.assertExists(account, `Account with ID ${accountId} not found`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Account does not belong to user');
      }

      return await this.transactionRepository.findByAccount(accountId, userId);
    } catch (error) {
      throw this.handleError(error, 'getTransactionsByAccount');
    }
  }

  async getTransactionsByDateRange(
    startDate: Date,
    endDate: Date,
    userId: string
  ): Promise<Transaction[]> {
    try {
      this.logDebug('Fetching transactions by date range', { startDate, endDate, userId });

      // Fetch all transactions in date range (userId filtering happens in repository)
      const allTransactions = await this.transactionRepository.findByDateRange(
        userId,
        startDate,
        endDate,
        undefined
      );

      return allTransactions;
    } catch (error) {
      throw this.handleError(error, 'getTransactionsByDateRange');
    }
  }

  async deleteTransaction(transactionId: string, userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting transaction', { transactionId });

      const existing = await this.transactionRepository.findById(transactionId);
      this.assertExists(existing, `Transaction with ID ${transactionId} not found`);

      // Verify ownership
      const holding = await this.holdingRepository.findById(existing.holdingId);
      this.assertExists(holding, `Holding not found for transaction ${transactionId}`);

      const account = await this.accountRepository.findById(holding.accountId);
      this.assertExists(account, `Account not found for holding ${holding.id}`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Transaction does not belong to user');
      }

      const deleted = await this.transactionRepository.delete(transactionId);
      this.logInfo('Transaction deleted', { transactionId, deleted });
      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteTransaction');
    }
  }
}
