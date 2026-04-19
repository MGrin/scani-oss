import { Container, Service } from 'typedi';
import type { NewUserIntegrationCredentials, UserIntegrationCredentials } from '../domain/entities';
import { UserIntegrationCredentialsRepository } from '../repositories/UserIntegrationCredentialsRepository';
import { decryptCredentials, encryptCredentials } from '../utils/encryption';
import { BaseService } from './BaseService';

export class ExpiredCredentialsError extends Error {
  readonly userId: string;
  readonly institutionId: string;
  readonly expiresAt: Date;

  constructor(userId: string, institutionId: string, expiresAt: Date) {
    super(`Credentials for institution ${institutionId} expired at ${expiresAt.toISOString()}`);
    this.name = 'ExpiredCredentialsError';
    this.userId = userId;
    this.institutionId = institutionId;
    this.expiresAt = expiresAt;
  }
}

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
   * Get decrypted credentials for a specific user and institution.
   * Throws ExpiredCredentialsError when expiresAt is in the past, so callers
   * get a clear signal to trigger a refresh flow instead of a cryptic 401
   * from the upstream provider.
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

      if (credentials.expiresAt && new Date() > new Date(credentials.expiresAt)) {
        throw new ExpiredCredentialsError(userId, institutionId, new Date(credentials.expiresAt));
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
        // Update existing credentials. Reset import_status to pending_enqueue
        // because the caller is about to try (re)enqueuing a fresh import job;
        // leaving it 'enqueued' would mask orphaned rows from the reconciler.
        const updated = await this.credentialsRepository.update(existing.id, {
          encryptedCredentials: encrypted,
          credentialsType,
          expiresAt,
          lastUsedAt: new Date(),
          isActive: true,
          importStatus: 'pending_enqueue',
          importJobId: null,
          importEnqueuedAt: null,
          importLastError: null,
        });
        this.assertExists(updated, 'Failed to update credentials');
        this.logDebug('Credentials updated successfully', { credentialsId: updated.id });
        return updated;
      }

      // Create new credentials. Default `import_status='pending_enqueue'` —
      // the caller flips it to 'enqueued' once BullMQ accepts the job.
      const data: NewUserIntegrationCredentials = {
        userId,
        institutionId,
        encryptedCredentials: encrypted,
        credentialsType,
        expiresAt,
        isActive: true,
        importStatus: 'pending_enqueue',
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
   * Promote a row from pending_enqueue → enqueued after BullMQ accepts the job.
   */
  async markImportEnqueued(id: string, jobId: string): Promise<void> {
    try {
      await this.credentialsRepository.markImportEnqueued(id, jobId);
    } catch (error) {
      throw this.handleError(error, 'markImportEnqueued');
    }
  }

  /**
   * Mark a row failed when enqueue throws. The row stays (so the UI can show
   * the error); the reconciler may later reset it to pending_enqueue for retry.
   */
  async markImportFailed(id: string, errorMessage: string): Promise<void> {
    try {
      await this.credentialsRepository.markImportFailed(id, errorMessage);
    } catch (error) {
      throw this.handleError(error, 'markImportFailed');
    }
  }

  /**
   * Reconciler helper: find rows stuck in pending_enqueue beyond the cutoff.
   */
  async findPendingEnqueueOlderThan(cutoff: Date) {
    try {
      return await this.credentialsRepository.findPendingEnqueueOlderThan(cutoff);
    } catch (error) {
      throw this.handleError(error, 'findPendingEnqueueOlderThan');
    }
  }

  /**
   * Reset a row to pending_enqueue for a retry attempt (reconciler or admin UI).
   */
  async resetImportToPending(id: string): Promise<void> {
    try {
      await this.credentialsRepository.resetImportToPending(id);
    } catch (error) {
      throw this.handleError(error, 'resetImportToPending');
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

      if (!credentials?.expiresAt) {
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
