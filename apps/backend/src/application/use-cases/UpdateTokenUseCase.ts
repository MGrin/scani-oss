import { Service } from 'typedi';
import type { Token } from '../../domain/entities';
import type { DatabaseTransaction } from '../../domain/interfaces/repositories/IBaseRepository';
import type { TokenPriceRepository } from '../../infrastructure/repositories/TokenPriceRepository';
import type { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { BaseService } from '../services/BaseService';

export interface UpdateTokenInput {
  id: string;
  description?: string;
  manualPrice?: number;
  priceDescription?: string;
}

/**
 * UpdateTokenUseCase
 *
 * Updates private tokens' descriptions and manual prices.
 * Only private tokens (private-company, other) can be updated.
 *
 * **Business Rules:**
 * 1. Only private tokens can be updated
 * 2. Public tokens are managed by external providers
 * 3. Description updates modify providerMetadata
 * 4. Price updates create new price entries (historical tracking)
 * 5. All updates are logged with timestamps
 */
@Service()
export class UpdateTokenUseCase extends BaseService {
  constructor(
    private readonly tokenRepository: TokenRepository,
    private readonly tokenPriceRepository: TokenPriceRepository
  ) {
    super('UpdateTokenUseCase');
  }

  /**
   * Execute token update
   *
   * @param input - Update data
   * @returns Updated token
   */
  async execute(input: UpdateTokenInput): Promise<Token> {
    try {
      this.logInfo('Updating token', {
        tokenId: input.id,
        hasDescriptionUpdate: input.description !== undefined,
        hasPriceUpdate: input.manualPrice !== undefined,
      });

      return await this.withTransaction(async (tx) => {
        // Get current token with type information
        const token = await this.tokenRepository.findByIdWithType(input.id, tx);
        this.assertExists(token, `Token with ID ${input.id} not found`);

        // Verify this is a private token
        if (!token.type || !this.isPrivateToken(token.type.code)) {
          throw new Error('Only private company and other tokens can be updated');
        }

        let updatedToken: Token | null = null;

        // Update description if provided
        if (input.description !== undefined) {
          updatedToken = await this.updateDescription(token, input.description, tx);
        }

        // Update manual price if provided
        if (input.manualPrice !== undefined) {
          await this.updateManualPrice(input.id, input.manualPrice, input.priceDescription, tx);
        }

        // If we didn't update metadata, get the current token
        if (!updatedToken) {
          updatedToken = await this.tokenRepository.findById(input.id, tx);
          this.assertExists(updatedToken, 'Token not found after update');
        }

        this.logInfo('Token updated successfully', {
          tokenId: updatedToken.id,
          symbol: updatedToken.symbol,
        });

        return updatedToken;
      });
    } catch (error) {
      throw this.handleError(error, 'execute');
    }
  }

  /**
   * Update token description in provider metadata
   */
  private async updateDescription(
    token: Token,
    description: string,
    tx?: DatabaseTransaction
  ): Promise<Token> {
    try {
      // Parse existing metadata
      const currentMetadata = token.providerMetadata ? JSON.parse(token.providerMetadata) : {};

      // Update metadata
      const updatedMetadata = {
        ...currentMetadata,
        description,
        updatedAt: new Date().toISOString(),
      };

      // Update token
      const updated = await this.tokenRepository.update(
        token.id,
        {
          providerMetadata: JSON.stringify(updatedMetadata),
        },
        tx
      );

      this.assertExists(updated, 'Failed to update token description');

      this.logDebug('Token description updated', {
        tokenId: token.id,
        descriptionLength: description.length,
      });

      return updated;
    } catch (error) {
      this.logError('Failed to update description', { tokenId: token.id, error });
      throw error;
    }
  }

  /**
   * Update manual price by creating a new price entry
   * Maintains historical price tracking
   */
  private async updateManualPrice(
    tokenId: string,
    price: number,
    priceDescription?: string,
    tx?: DatabaseTransaction
  ): Promise<void> {
    try {
      // Validate price
      if (price <= 0) {
        throw new Error('Manual price must be greater than 0');
      }

      // Get USD token as base currency
      const usdToken = await this.tokenRepository.findBySymbolAndTypeCode('USD', 'fiat', tx);

      if (!usdToken) {
        throw new Error('USD base token not found - required for manual pricing');
      }

      // Create new price entry (maintains history)
      await this.tokenPriceRepository.create(
        {
          tokenId,
          baseTokenId: usdToken.id,
          price: price.toString(),
          timestamp: new Date(),
          source: `manual_update - ${priceDescription || 'Price updated'}`,
        },
        tx
      );

      this.logDebug('Manual price updated', {
        tokenId,
        price,
        baseToken: 'USD',
      });
    } catch (error) {
      this.logError('Failed to update manual price', { tokenId, price, error });
      throw error;
    }
  }

  /**
   * Check if a token is private (editable)
   */
  private isPrivateToken(typeCode: string): boolean {
    return typeCode === 'private-company' || typeCode === 'other';
  }
}
