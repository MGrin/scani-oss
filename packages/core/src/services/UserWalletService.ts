import { Container, Service } from 'typedi';
import type { NewUserWallet, UserWallet } from '../domain/entities';
import { UserWalletRepository } from '../repositories/UserWalletRepository';
import { BaseService } from './BaseService';

@Service()
export class UserWalletService extends BaseService {
  private readonly userWalletRepository = Container.get(UserWalletRepository);

  constructor() {
    super('UserWalletService');
  }

  /**
   * Get all wallets for a user
   */
  async getUserWallets(userId: string): Promise<UserWallet[]> {
    try {
      // Note: Not logging individual wallet retrievals to reduce log volume
      return await this.userWalletRepository.findByUser(userId);
    } catch (error) {
      throw this.handleError(error, 'getUserWallets');
    }
  }

  /**
   * Get a specific wallet by ID
   */
  async getWalletById(walletId: string): Promise<UserWallet | null> {
    try {
      this.logDebug('Getting wallet by ID', { walletId });
      return await this.userWalletRepository.findById(walletId);
    } catch (error) {
      throw this.handleError(error, 'getWalletById');
    }
  }

  /**
   * Get wallet by user and address
   */
  async getWalletByAddress(userId: string, walletAddress: string): Promise<UserWallet | null> {
    try {
      this.logDebug('Getting wallet by address', { userId, walletAddress });
      const wallet = await this.userWalletRepository.findByUserAndAddress(userId, walletAddress);
      return wallet || null;
    } catch (error) {
      throw this.handleError(error, 'getWalletByAddress');
    }
  }

  /**
   * Create a new wallet
   */
  async createWallet(data: NewUserWallet): Promise<UserWallet> {
    try {
      this.logInfo('Creating wallet', { data });

      // Check if wallet already exists
      const existing = await this.userWalletRepository.findByUserAndAddress(
        data.userId,
        data.walletAddress
      );
      if (existing) {
        throw new Error('Wallet with this address already exists for this user');
      }

      const wallet = await this.userWalletRepository.create(data);
      this.assertExists(wallet, 'Failed to create wallet');

      this.logDebug('Wallet created successfully', { walletId: wallet.id });
      return wallet;
    } catch (error) {
      throw this.handleError(error, 'createWallet');
    }
  }

  /**
   * Update a wallet
   */
  async updateWallet(walletId: string, data: Partial<UserWallet>): Promise<UserWallet> {
    try {
      this.logInfo('Updating wallet', { walletId, data });

      // Check if wallet exists
      const existingWallet = await this.userWalletRepository.findById(walletId);
      this.assertExists(existingWallet, `Wallet with ID ${walletId} not found`);

      const updatedWallet = await this.userWalletRepository.update(walletId, data);
      this.assertExists(updatedWallet, 'Failed to update wallet');

      this.logInfo('Wallet updated successfully', { walletId: updatedWallet.id });
      return updatedWallet;
    } catch (error) {
      throw this.handleError(error, 'updateWallet');
    }
  }

  /**
   * Add an institution to a wallet's institution list
   */
  async addInstitutionToWallet(walletId: string, institutionId: string): Promise<UserWallet> {
    try {
      this.logInfo('Adding institution to wallet', { walletId, institutionId });

      const wallet = await this.userWalletRepository.findById(walletId);
      this.assertExists(wallet, `Wallet with ID ${walletId} not found`);

      const institutionIds = (wallet.institutionIds as string[]) || [];
      if (!institutionIds.includes(institutionId)) {
        institutionIds.push(institutionId);
        return await this.updateWallet(walletId, { institutionIds });
      }

      return wallet;
    } catch (error) {
      throw this.handleError(error, 'addInstitutionToWallet');
    }
  }

  /**
   * Remove an institution from a wallet's institution list
   */
  async removeInstitutionFromWallet(walletId: string, institutionId: string): Promise<UserWallet> {
    try {
      this.logInfo('Removing institution from wallet', { walletId, institutionId });

      const wallet = await this.userWalletRepository.findById(walletId);
      this.assertExists(wallet, `Wallet with ID ${walletId} not found`);

      const institutionIds = (wallet.institutionIds as string[]) || [];
      const filtered = institutionIds.filter((id) => id !== institutionId);

      return await this.updateWallet(walletId, { institutionIds: filtered });
    } catch (error) {
      throw this.handleError(error, 'removeInstitutionFromWallet');
    }
  }

  /**
   * Delete a wallet (soft delete)
   */
  async deleteWallet(walletId: string): Promise<void> {
    try {
      this.logInfo('Deleting wallet', { walletId });

      const wallet = await this.userWalletRepository.findById(walletId);
      this.assertExists(wallet, `Wallet with ID ${walletId} not found`);

      await this.userWalletRepository.update(walletId, { isActive: false });

      this.logInfo('Wallet deleted successfully', { walletId });
    } catch (error) {
      throw this.handleError(error, 'deleteWallet');
    }
  }

  /**
   * Get wallets by institution (network)
   */
  async getWalletsByInstitution(institutionId: string): Promise<UserWallet[]> {
    try {
      this.logInfo('Getting wallets by institution', { institutionId });
      return await this.userWalletRepository.findByInstitution(institutionId);
    } catch (error) {
      throw this.handleError(error, 'getWalletsByInstitution');
    }
  }
}
