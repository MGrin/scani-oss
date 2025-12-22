import { Container, Service } from 'typedi';
import type { NewUserIntegrationCredentials, UserIntegrationCredentials } from '../domain/entities';
import { UserIntegrationCredentialsRepository } from '../repositories/UserIntegrationCredentialsRepository';
import { decryptCredentials, encryptCredentials } from '../utils/encryption';
import { BaseService } from './BaseService';

/**
 * Service for managing user integration credentials with encryption
 * Handles OAuth tokens, API keys, and other sensitive credentials
 */
@Service()
export class IntegrationCredentialsService extends BaseService {
  private readonly credentialsRepository = Container.get(UserIntegrationCredentialsRepository);

  constructor() {
    super('IntegrationCredentialsService');
  }

  /**
   * Get all credentials for a user
   */
  async getUserCredentials(userId: string): Promise<UserIntegrationCredentials[]> {
    try {
      // Note: Not logging individual credential retrievals to reduce log volume
      return await this.credentialsRepository.findByUser(userId);
    } catch (error) {
      throw this.handleError(error, 'getUserCredentials');
    }
  }

  /**
   * Get credentials for a specific user and institution
   */
  async getCredentials(
    userId: string,
    institutionId: string
  ): Promise<UserIntegrationCredentials | null> {
    try {
      this.logDebug('Getting credentials', { userId, institutionId });
      const credentials = await this.credentialsRepository.findByUserAndInstitution(
        userId,
        institutionId
      );
      return credentials || null;
    } catch (error) {
      throw this.handleError(error, 'getCredentials');
    }
  }

  /**
   * Get decrypted credentials for a specific user and institution
   */
  async getDecryptedCredentials(
    userId: string,
    institutionId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      // Note: Not logging credential decryption to reduce log volume
      const credentials = await this.credentialsRepository.findByUserAndInstitution(
        userId,
        institutionId
      );

      if (!credentials) {
        return null;
      }

      // Decrypt the credentials
      const decrypted = decryptCredentials(
        credentials.encryptedCredentials as Record<string, unknown>
      );

      // Update last used timestamp
      await this.credentialsRepository.updateLastUsed(credentials.id);

      return decrypted;
    } catch (error) {
      throw this.handleError(error, 'getDecryptedCredentials');
    }
  }

  /**
   * Store encrypted credentials
   */
  async storeCredentials(
    userId: string,
    institutionId: string,
    credentials: Record<string, unknown>,
    credentialsType: string,
    expiresAt?: Date
  ): Promise<UserIntegrationCredentials> {
    try {
      this.logDebug('Storing credentials', { userId, institutionId, credentialsType });

      // Encrypt the credentials
      const encrypted = encryptCredentials(credentials);

      // Check if credentials already exist
      const existing = await this.credentialsRepository.findByUserAndInstitution(
        userId,
        institutionId
      );

      if (existing) {
        // Update existing credentials
        const updated = await this.credentialsRepository.update(existing.id, {
          encryptedCredentials: encrypted,
          credentialsType,
          expiresAt,
          lastUsedAt: new Date(),
          isActive: true,
        });
        this.assertExists(updated, 'Failed to update credentials');
        this.logDebug('Credentials updated successfully', { credentialsId: updated.id });
        return updated;
      }

      // Create new credentials
      const data: NewUserIntegrationCredentials = {
        userId,
        institutionId,
        encryptedCredentials: encrypted,
        credentialsType,
        expiresAt,
        isActive: true,
      };

      const created = await this.credentialsRepository.create(data);
      this.assertExists(created, 'Failed to create credentials');

      this.logDebug('Credentials stored successfully', { credentialsId: created.id });
      return created;
    } catch (error) {
      throw this.handleError(error, 'storeCredentials');
    }
  }

  /**
   * Update encrypted credentials
   */
  async updateCredentials(
    userId: string,
    institutionId: string,
    credentials: Record<string, unknown>
  ): Promise<UserIntegrationCredentials> {
    try {
      this.logInfo('Updating credentials', { userId, institutionId });

      const existing = await this.credentialsRepository.findByUserAndInstitution(
        userId,
        institutionId
      );
      this.assertExists(existing, 'Credentials not found');

      // Encrypt the new credentials
      const encrypted = encryptCredentials(credentials);

      const updated = await this.credentialsRepository.update(existing.id, {
        encryptedCredentials: encrypted,
        lastUsedAt: new Date(),
      });
      this.assertExists(updated, 'Failed to update credentials');

      this.logInfo('Credentials updated successfully', { credentialsId: updated.id });
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateCredentials');
    }
  }

  /**
   * Delete credentials (soft delete)
   */
  async deleteCredentials(userId: string, institutionId: string): Promise<void> {
    try {
      this.logInfo('Deleting credentials', { userId, institutionId });

      const existing = await this.credentialsRepository.findByUserAndInstitution(
        userId,
        institutionId
      );
      this.assertExists(existing, 'Credentials not found');

      await this.credentialsRepository.update(existing.id, { isActive: false });

      this.logInfo('Credentials deleted successfully', { credentialsId: existing.id });
    } catch (error) {
      throw this.handleError(error, 'deleteCredentials');
    }
  }

  /**
   * Check if credentials are expired
   */
  async areCredentialsExpired(userId: string, institutionId: string): Promise<boolean> {
    try {
      const credentials = await this.credentialsRepository.findByUserAndInstitution(
        userId,
        institutionId
      );

      if (!credentials || !credentials.expiresAt) {
        return false;
      }

      return new Date() > new Date(credentials.expiresAt);
    } catch (error) {
      throw this.handleError(error, 'areCredentialsExpired');
    }
  }

  /**
   * Get all credentials for an institution
   */
  async getInstitutionCredentials(institutionId: string): Promise<UserIntegrationCredentials[]> {
    try {
      this.logInfo('Getting institution credentials', { institutionId });
      return await this.credentialsRepository.findByInstitution(institutionId);
    } catch (error) {
      throw this.handleError(error, 'getInstitutionCredentials');
    }
  }

  /**
   * Get credentials by type
   */
  async getCredentialsByType(
    userId: string,
    credentialsType: string
  ): Promise<UserIntegrationCredentials[]> {
    try {
      this.logInfo('Getting credentials by type', { userId, credentialsType });
      return await this.credentialsRepository.findByType(userId, credentialsType);
    } catch (error) {
      throw this.handleError(error, 'getCredentialsByType');
    }
  }
}
