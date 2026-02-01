import * as bcrypt from 'bcryptjs';
import { Container, Service } from 'typedi';
import type { ApiKey } from '../repositories/ApiKeyRepository';
import { ApiKeyRepository } from '../repositories/ApiKeyRepository';
import { BaseService } from './BaseService';

const API_KEY_PREFIX = 'sk_live_';
const API_KEY_LENGTH = 32; // Length of random part after prefix
const BCRYPT_ROUNDS = 10;

export interface CreateApiKeyInput {
  userId: string;
  name: string;
  expiresAt?: Date;
}

export interface ApiKeyWithPlaintext extends Omit<ApiKey, 'keyHash'> {
  plainKey: string; // Only returned once upon creation
}

export interface ApiKeyListItem
  extends Omit<ApiKey, 'keyHash' | 'userId' | 'createdAt' | 'updatedAt'> {
  createdAt: Date;
  updatedAt: Date;
}

export interface ValidatedApiKey {
  apiKey: ApiKey;
  userId: string;
}

@Service()
export class ApiKeyService extends BaseService {
  private readonly apiKeyRepository = Container.get(ApiKeyRepository);

  constructor() {
    super('ApiKeyService');
  }

  /**
   * Generate a secure random API key with the format sk_live_<random>
   */
  generateApiKey(): string {
    const randomBytes = crypto.getRandomValues(new Uint8Array(API_KEY_LENGTH));
    const randomString = Array.from(randomBytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `${API_KEY_PREFIX}${randomString}`;
  }

  /**
   * Hash an API key using bcrypt
   */
  private async hashApiKey(key: string): Promise<string> {
    return await bcrypt.hash(key, BCRYPT_ROUNDS);
  }

  /**
   * Verify an API key against its hash
   */
  private async verifyApiKey(key: string, hash: string): Promise<boolean> {
    return await bcrypt.compare(key, hash);
  }

  /**
   * Extract the prefix from an API key (first 8 characters)
   */
  private extractPrefix(key: string): string {
    return key.substring(0, 8);
  }

  /**
   * Create a new API key for a user
   * Returns the plaintext key (only shown once) along with the stored record
   */
  async createApiKey(input: CreateApiKeyInput): Promise<ApiKeyWithPlaintext> {
    try {
      this.logInfo('Creating API key', { userId: input.userId, name: input.name });

      // Generate the API key
      const plainKey = this.generateApiKey();
      const keyHash = await this.hashApiKey(plainKey);
      const keyPrefix = this.extractPrefix(plainKey);

      // Validate expiration date if provided
      if (input.expiresAt && input.expiresAt <= new Date()) {
        throw new Error('Expiration date must be in the future');
      }

      // Store in database
      const apiKey = await this.apiKeyRepository.create({
        userId: input.userId,
        name: input.name,
        keyHash,
        keyPrefix,
        expiresAt: input.expiresAt,
        isActive: true,
      });

      this.logInfo('API key created successfully', { id: apiKey.id, userId: input.userId });

      // Return with plaintext key (only time it's visible)
      return {
        ...apiKey,
        plainKey,
      };
    } catch (error) {
      throw this.handleError(error, 'createApiKey');
    }
  }

  /**
   * List all API keys for a user (without the actual keys)
   */
  async listApiKeys(userId: string): Promise<ApiKeyListItem[]> {
    try {
      this.logInfo('Listing API keys', { userId });

      const apiKeys = await this.apiKeyRepository.findByUserId(userId);

      // Remove sensitive fields
      return apiKeys.map((key) => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        isActive: key.isActive,
        createdAt: key.createdAt,
        updatedAt: key.updatedAt,
      }));
    } catch (error) {
      throw this.handleError(error, 'listApiKeys');
    }
  }

  /**
   * Revoke (deactivate) an API key
   */
  async revokeApiKey(userId: string, keyId: string): Promise<void> {
    try {
      this.logInfo('Revoking API key', { userId, keyId });

      // Verify ownership
      const apiKey = await this.apiKeyRepository.findByUserAndKeyId(userId, keyId);
      this.assertExists(apiKey, 'API key not found or does not belong to user');

      // Revoke the key
      await this.apiKeyRepository.revoke(keyId);

      this.logInfo('API key revoked successfully', { keyId });
    } catch (error) {
      throw this.handleError(error, 'revokeApiKey');
    }
  }

  /**
   * Validate an API key and return the associated user
   * This is called during MCP authentication
   */
  async validateApiKey(key: string): Promise<ValidatedApiKey> {
    try {
      // Extract prefix to narrow down database query
      const keyPrefix = this.extractPrefix(key);

      // Find active keys with matching prefix
      const candidates = await this.apiKeyRepository.findActiveByPrefix(keyPrefix);

      if (candidates.length === 0) {
        throw new Error('Invalid API key');
      }

      // Verify the key hash against each candidate
      for (const candidate of candidates) {
        const isValid = await this.verifyApiKey(key, candidate.keyHash);

        if (isValid) {
          // Check expiration
          if (candidate.expiresAt && candidate.expiresAt < new Date()) {
            throw new Error('API key has expired');
          }

          // Update last used timestamp (don't await to avoid blocking)
          this.apiKeyRepository.updateLastUsed(candidate.id).catch((error) => {
            this.logError('Failed to update last used timestamp', { error, keyId: candidate.id });
          });

          this.logInfo('API key validated successfully', {
            userId: candidate.userId,
            keyId: candidate.id,
          });

          return {
            apiKey: candidate,
            userId: candidate.userId,
          };
        }
      }

      // No matching key found
      throw new Error('Invalid API key');
    } catch (error) {
      // Don't log the actual key for security reasons
      this.logError('API key validation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}
