import { Service } from 'typedi';
import type { TokenTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import type { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { BaseService } from '../services/BaseService';
import type { TokenValidationService } from '../services/TokenValidationService';

export interface ValidateTokenInput {
  symbol: string;
  typeCode?: string; // Optional type to guide provider selection
  coinGeckoId?: string; // Optional specific CoinGecko ID
}

export interface ValidateTokenResult {
  isValid: boolean;
  error?: string;
  metadata?: {
    symbol: string;
    name: string;
    type: string;
    provider: 'finnhub' | 'coingecko';
    providerMetadata?: Record<string, unknown>;
  };
  existsInDatabase: boolean;
  existingToken?: {
    id: string;
    symbol: string;
    name: string | null;
    isActive: boolean;
  } | null;
}

/**
 * ValidateTokenUseCase
 *
 * Validates tokens against external providers (CoinGecko, Finnhub)
 * and checks if the token already exists in the database.
 *
 * **Business Rules:**
 * 1. Validates token against appropriate external provider
 * 2. Checks for existing token in database with matching type
 * 3. Returns validation result with provider metadata
 * 4. Supports validation by symbol or specific CoinGecko ID
 */
@Service()
export class ValidateTokenUseCase extends BaseService {
  constructor(
    private readonly tokenValidationService: TokenValidationService,
    private readonly tokenRepository: TokenRepository,
    private readonly tokenTypeRepository: TokenTypeRepository
  ) {
    super('ValidateTokenUseCase');
  }

  /**
   * Execute validation for a token
   *
   * @param input - Token validation input
   * @returns Validation result with metadata and database check
   */
  async execute(input: ValidateTokenInput): Promise<ValidateTokenResult> {
    try {
      this.logInfo('Validating token', {
        symbol: input.symbol,
        typeCode: input.typeCode,
        coinGeckoId: input.coinGeckoId,
      });

      // Validate token against external provider
      const validation = input.coinGeckoId
        ? await this.tokenValidationService.validateTokenByCoinGeckoId(input.coinGeckoId)
        : await this.tokenValidationService.validateToken(input.symbol, input.typeCode);

      if (!validation.isValid) {
        this.logWarning('Token validation failed', {
          symbol: input.symbol,
          error: validation.error,
        });
        return {
          isValid: false,
          error: validation.error,
          existsInDatabase: false,
          existingToken: null,
        };
      }

      if (!validation.metadata) {
        this.logWarning('Token validation succeeded but no metadata returned', {
          symbol: input.symbol,
        });
        return {
          isValid: false,
          error: 'Validation succeeded but no metadata available',
          existsInDatabase: false,
          existingToken: null,
        };
      }

      // Check if token exists in database
      const { existsInDatabase, existingToken } = await this.checkDatabaseExistence(
        validation.metadata.symbol,
        validation.metadata.type
      );

      this.logInfo('Token validation completed', {
        symbol: input.symbol,
        isValid: true,
        provider: validation.metadata.provider,
        existsInDatabase,
      });

      return {
        isValid: true,
        metadata: validation.metadata,
        existsInDatabase,
        existingToken,
      };
    } catch (error) {
      throw this.handleError(error, 'execute');
    }
  }

  /**
   * Check if a token exists in the database
   *
   * @param symbol - Token symbol
   * @param providerType - Provider type from validation
   * @returns Database existence check result
   */
  private async checkDatabaseExistence(
    symbol: string,
    providerType: string
  ): Promise<{
    existsInDatabase: boolean;
    existingToken?: {
      id: string;
      symbol: string;
      name: string | null;
      isActive: boolean;
    } | null;
  }> {
    try {
      // Map provider type to database type
      const tokenTypeCode = this.mapProviderTypeToDbType(providerType);

      // Get the token type ID
      const tokenType = await this.tokenTypeRepository.findByCode(tokenTypeCode);

      if (!tokenType) {
        this.logWarning('Token type not found in database', {
          tokenTypeCode,
          providerType,
        });
        return {
          existsInDatabase: false,
          existingToken: null,
        };
      }

      // Check if token exists with this type
      const existingToken = await this.tokenRepository.findBySymbolAndType(symbol, tokenType.id);

      if (existingToken) {
        return {
          existsInDatabase: true,
          existingToken: {
            id: existingToken.id,
            symbol: existingToken.symbol,
            name: existingToken.name,
            isActive: existingToken.isActive,
          },
        };
      }

      return {
        existsInDatabase: false,
        existingToken: null,
      };
    } catch (error) {
      this.logError('Error checking database existence', { symbol, providerType, error });
      return {
        existsInDatabase: false,
        existingToken: null,
      };
    }
  }

  /**
   * Map provider token type to database token type
   *
   * @param providerType - Type from external provider
   * @returns Database token type code
   */
  private mapProviderTypeToDbType(providerType: string): string {
    switch (providerType) {
      case 'Equity':
      case 'ETF':
      case 'Mutual Fund':
      case 'Bond':
      case 'Commodity':
        // All equity-like instruments map to 'stock' type
        return 'stock';
      case 'Crypto':
      case 'Cryptocurrency':
        return 'crypto';
      default:
        return 'stock'; // Default fallback for unknown types
    }
  }

  /**
   * Batch validate multiple tokens
   * Useful for bulk operations or import
   *
   * @param inputs - Array of token validation inputs
   * @returns Map of symbol to validation result
   */
  async executeBatch(inputs: ValidateTokenInput[]): Promise<Map<string, ValidateTokenResult>> {
    try {
      this.logInfo('Batch validating tokens', { count: inputs.length });

      const results = new Map<string, ValidateTokenResult>();

      for (const input of inputs) {
        try {
          const result = await this.execute(input);
          results.set(input.symbol, result);
        } catch (error) {
          this.logError('Failed to validate token in batch', {
            symbol: input.symbol,
            error,
          });
          results.set(input.symbol, {
            isValid: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            existsInDatabase: false,
            existingToken: null,
          });
        }
      }

      this.logInfo('Batch validation completed', {
        total: inputs.length,
        successful: Array.from(results.values()).filter((r) => r.isValid).length,
        failed: Array.from(results.values()).filter((r) => !r.isValid).length,
      });

      return results;
    } catch (error) {
      throw this.handleError(error, 'executeBatch');
    }
  }
}
