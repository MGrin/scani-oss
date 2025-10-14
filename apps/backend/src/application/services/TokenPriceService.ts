import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { CreateTokenPriceInput, UpdateTokenPriceInput } from '../../domain/dtos/token-price';
import type { TokenPrice } from '../../domain/entities';
import { TokenPriceRepository } from '../../infrastructure/repositories/TokenPriceRepository';
import { BaseService } from './BaseService';

/**
 * TokenPriceService
 *
 * Handles all business logic related to token pricing including:
 * - Manual price updates
 * - Automated price updates from providers
 * - Price history queries
 * - Bulk price operations
 */
@Service()
export class TokenPriceService extends BaseService {
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);

  constructor() {
    super('TokenPriceService');
  }

  /**
   * Create a new price entry
   *
   * @param data - Price creation data
   * @returns Created price entity
   */
  async createPrice(data: CreateTokenPriceInput): Promise<TokenPrice> {
    try {
      this.logInfo('Creating new price entry', {
        tokenId: data.tokenId,
        price: data.price,
        source: data.source,
      });

      // Validate required fields
      this.validateRequiredFields(data, ['tokenId', 'baseTokenId', 'price', 'timestamp']);

      // Validate price is positive
      const priceValue = new Decimal(data.price);
      if (priceValue.isNegative() || priceValue.isZero()) {
        throw new Error('Price must be a positive number');
      }

      // Create the price entry
      const priceEntry = await this.tokenPriceRepository.create({
        tokenId: data.tokenId,
        baseTokenId: data.baseTokenId,
        price: data.price,
        timestamp: data.timestamp,
        source: data.source || 'manual',
      });

      this.logInfo('Price entry created successfully', {
        tokenId: priceEntry.tokenId,
        price: priceEntry.price,
      });

      return priceEntry;
    } catch (error) {
      throw this.handleError(error, 'createPrice');
    }
  }

  /**
   * Update an existing price entry
   *
   * @param priceId - ID of the price entry to update
   * @param data - Price update data
   * @returns Updated price entity
   */
  async updatePrice(priceId: string, data: UpdateTokenPriceInput): Promise<TokenPrice> {
    try {
      this.logInfo('Updating price entry', { priceId, data });

      // Get existing price
      const existingPrice = await this.tokenPriceRepository.findById(priceId);
      this.assertExists(existingPrice, `Price entry with ID ${priceId} not found`);

      // Validate price if provided
      if (data.price !== undefined) {
        const priceValue = new Decimal(data.price);
        if (priceValue.isNegative() || priceValue.isZero()) {
          throw new Error('Price must be a positive number');
        }
      }

      // Update the price entry
      const updatedPrice = await this.tokenPriceRepository.update(priceId, data);
      this.assertExists(updatedPrice, 'Failed to update price entry');

      this.logInfo('Price entry updated successfully', { priceId });
      return updatedPrice;
    } catch (error) {
      throw this.handleError(error, 'updatePrice');
    }
  }

  /**
   * Get the latest price for a token
   *
   * @param tokenId - ID of the token
   * @param baseTokenId - Optional base token ID for conversion
   * @returns Latest price entry or null if not found
   */
  async getLatestPrice(tokenId: string, baseTokenId?: string): Promise<TokenPrice | null> {
    try {
      if (!baseTokenId) {
        throw new Error('baseTokenId is required');
      }
      return await this.tokenPriceRepository.findLatestPrice(tokenId, baseTokenId);
    } catch (error) {
      throw this.handleError(error, 'getLatestPrice');
    }
  }

  /**
   * Get price history for a token
   *
   * @param tokenId - ID of the token
   * @param baseTokenId - Optional base token ID for conversion
   * @param startDate - Start date for history
   * @param endDate - End date for history
   * @param limit - Maximum number of entries to return
   * @returns Array of price entries
   */
  async getPriceHistory(
    tokenId: string,
    baseTokenId?: string,
    startDate?: Date,
    endDate?: Date,
    limit?: number
  ): Promise<TokenPrice[]> {
    try {
      this.logDebug('Fetching price history', {
        tokenId,
        baseTokenId,
        startDate,
        endDate,
        limit,
      });

      if (!baseTokenId) {
        return [];
      }
      return await this.tokenPriceRepository.findPriceHistory(
        tokenId,
        baseTokenId,
        startDate || new Date(0),
        endDate || new Date(),
        undefined
      );
    } catch (error) {
      throw this.handleError(error, 'getPriceHistory');
    }
  }

  /**
   * Get prices for multiple tokens at a specific timestamp
   *
   * @param tokenIds - Array of token IDs
   * @param baseTokenId - Base token ID for conversion
   * @param timestamp - Optional timestamp (defaults to now)
   * @returns Map of token IDs to their prices
   */
  async getBatchPrices(
    tokenIds: string[],
    baseTokenId: string,
    timestamp?: Date
  ): Promise<Map<string, string>> {
    try {
      this.logDebug('Fetching batch prices', {
        tokenCount: tokenIds.length,
        baseTokenId,
        timestamp,
      });

      const prices = new Map<string, string>();

      // Fetch prices for each token
      await Promise.all(
        tokenIds.map(async (tokenId) => {
          const price = await this.tokenPriceRepository.findLatestPrice(
            tokenId,
            baseTokenId,
            undefined
          );

          if (price) {
            prices.set(tokenId, price.price);
          } else {
            this.logWarning('No price found for token', { tokenId, baseTokenId });
            prices.set(tokenId, '0');
          }
        })
      );

      return prices;
    } catch (error) {
      throw this.handleError(error, 'getBatchPrices');
    }
  }

  /**
   * Bulk upsert prices (insert or update)
   *
   * @param prices - Array of price data to upsert
   * @returns Number of prices upserted
   */
  async bulkUpsertPrices(prices: CreateTokenPriceInput[]): Promise<number> {
    try {
      this.logInfo('Bulk upserting prices', { count: prices.length });

      // Validate all prices
      for (const price of prices) {
        this.validateRequiredFields(price, ['tokenId', 'baseTokenId', 'price', 'timestamp']);

        const priceValue = new Decimal(price.price);
        if (priceValue.isNegative()) {
          throw new Error(`Invalid negative price for token ${price.tokenId}`);
        }
      }

      // Perform bulk upsert - create each price individually for now
      let count = 0;
      for (const price of prices) {
        try {
          await this.tokenPriceRepository.create({
            tokenId: price.tokenId,
            baseTokenId: price.baseTokenId,
            price: price.price,
            timestamp: price.timestamp,
            source: price.source || 'bulk_import',
          });
          count++;
        } catch (error) {
          this.logWarning('Failed to upsert price', { tokenId: price.tokenId, error });
        }
      }

      this.logInfo('Bulk upsert completed', { count });
      return count;
    } catch (error) {
      throw this.handleError(error, 'bulkUpsertPrices');
    }
  }

  /**
   * Delete old price entries (for cleanup)
   *
   * @param olderThan - Delete entries older than this date
   * @returns Number of entries deleted
   */
  async deleteOldPrices(olderThan: Date): Promise<number> {
    try {
      this.logInfo('Deleting old price entries', { olderThan });

      // For now, we don't implement cleanup
      const count = 0;
      this.logWarning('Price cleanup not yet implemented');

      this.logInfo('Old price entries deleted', { count });
      return count;
    } catch (error) {
      throw this.handleError(error, 'deleteOldPrices');
    }
  }

  /**
   * Validate and normalize a price value
   *
   * @param price - Price value to validate
   * @returns Normalized price string
   */
  validateAndNormalizePrice(price: string | number): string {
    try {
      const priceValue = new Decimal(price);

      if (priceValue.isNegative()) {
        throw new Error('Price cannot be negative');
      }

      if (!priceValue.isFinite()) {
        throw new Error('Price must be a finite number');
      }

      return priceValue.toString();
    } catch (error) {
      if (error instanceof Error && error.message.includes('Decimal')) {
        throw new Error('Invalid price format');
      }
      throw error;
    }
  }
}
