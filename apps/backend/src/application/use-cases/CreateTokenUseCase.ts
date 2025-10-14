import { Service } from 'typedi';
import type { Token } from '../../domain/entities';
import type { DatabaseTransaction } from '../../domain/interfaces/repositories/IBaseRepository';
import type { TokenTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import type { TokenPriceRepository } from '../../infrastructure/repositories/TokenPriceRepository';
import type { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { BaseService } from '../services/BaseService';
import type { TokenValidationService } from '../services/TokenValidationService';

export interface CreateTokenInput {
  symbol: string;
  name?: string;
  typeId?: string; // Token type code (e.g., 'crypto', 'stock', 'private-company')
  decimals?: number;
  iconUrl?: string;
  isActive?: boolean;
  // For private tokens
  manualPrice?: number;
  priceDescription?: string;
  description?: string;
  // For external tokens - exact CoinGecko ID
  coinGeckoId?: string;
}

export interface CreateTokenResult {
  token: Token;
  isPrivate: boolean;
  provider?: 'finnhub' | 'coingecko' | 'manual';
}

/**
 * CreateTokenUseCase
 *
 * Creates a new token with validation and price initialization.
 * Handles both private tokens (manual pricing) and public tokens (external validation).
 *
 * **Business Rules:**
 * 1. Private tokens (private-company, other) require manual price
 * 2. Public tokens must be validated against external providers
 * 3. Fiat tokens cannot be created (system-managed)
 * 4. Symbol + Type combination must be unique
 * 5. Private tokens get initial price in USD
 * 6. Public tokens store provider metadata for future price updates
 */
@Service()
export class CreateTokenUseCase extends BaseService {
  constructor(
    private readonly tokenRepository: TokenRepository,
    private readonly tokenTypeRepository: TokenTypeRepository,
    private readonly tokenPriceRepository: TokenPriceRepository,
    private readonly tokenValidationService: TokenValidationService
  ) {
    super('CreateTokenUseCase');
  }

  /**
   * Execute token creation
   *
   * @param input - Token creation data
   * @returns Created token with metadata
   */
  async execute(input: CreateTokenInput): Promise<CreateTokenResult> {
    try {
      this.logInfo('Creating token', {
        symbol: input.symbol,
        typeId: input.typeId,
        isPrivate: this.isPrivateTokenType(input.typeId),
      });

      // Normalize symbol to uppercase
      const symbol = input.symbol.toUpperCase();

      // Determine if this is a private token
      const isPrivate = this.isPrivateTokenType(input.typeId);

      if (isPrivate) {
        return await this.createPrivateToken(symbol, input);
      } else {
        return await this.createPublicToken(symbol, input);
      }
    } catch (error) {
      throw this.handleError(error, 'execute');
    }
  }

  /**
   * Create a private token (private-company, other)
   * Private tokens don't require external validation
   */
  private async createPrivateToken(
    symbol: string,
    input: CreateTokenInput
  ): Promise<CreateTokenResult> {
    // Validate manual price is provided
    if (!input.manualPrice) {
      throw new Error('Manual price is required for private tokens');
    }

    if (input.manualPrice <= 0) {
      throw new Error('Manual price must be greater than 0');
    }

    return await this.withTransaction(async (tx) => {
      // Get token type
      if (!input.typeId) {
        throw new Error('Token type is required for private tokens');
      }

      const tokenType = await this.tokenTypeRepository.findByCode(input.typeId, tx);
      if (!tokenType) {
        throw new Error(`Token type '${input.typeId}' not found`);
      }

      // Check uniqueness
      const existing = await this.tokenRepository.findBySymbolAndType(symbol, tokenType.id, tx);

      if (existing) {
        throw new Error(`Private token ${symbol} already exists`);
      }

      // Create token
      const token = await this.tokenRepository.create(
        {
          symbol,
          name: input.name || symbol,
          typeId: tokenType.id,
          decimals: input.decimals || 2,
          iconUrl: input.iconUrl || null,
          providerMetadata: JSON.stringify({
            provider: 'manual',
            description: input.description || '',
            createdAt: new Date().toISOString(),
          }),
          isActive: input.isActive ?? true,
        },
        tx
      );

      this.assertExists(token, 'Failed to create private token');

      // Create initial price entry in USD
      if (input.manualPrice) {
        await this.createManualPrice(token.id, input.manualPrice, input.priceDescription, tx);
      }

      this.logInfo('Private token created successfully', {
        tokenId: token.id,
        symbol: token.symbol,
        manualPrice: input.manualPrice,
      });

      return {
        token,
        isPrivate: true,
        provider: 'manual',
      };
    });
  }

  /**
   * Create a public token (crypto, stock, etc.)
   * Public tokens require external validation
   */
  private async createPublicToken(
    symbol: string,
    input: CreateTokenInput
  ): Promise<CreateTokenResult> {
    return await this.withTransaction(async (tx) => {
      // Validate token against external provider
      const validation = input.coinGeckoId
        ? await this.tokenValidationService.validateTokenByCoinGeckoId(input.coinGeckoId)
        : await this.tokenValidationService.validateToken(symbol, input.typeId);

      if (!validation.isValid || !validation.metadata) {
        throw new Error(validation.error || 'Token validation failed');
      }

      // Determine token type
      let typeId = input.typeId;
      if (!typeId) {
        // Map provider type to our token type
        const mappedTypeCode = this.mapProviderTypeToDbType(validation.metadata.type);

        // Forbid creation of fiat tokens
        if (mappedTypeCode === 'fiat') {
          throw new Error(
            'Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators.'
          );
        }

        const tokenType = await this.tokenTypeRepository.findByCode(mappedTypeCode, tx);
        if (!tokenType) {
          throw new Error(`Token type '${mappedTypeCode}' not found in database`);
        }

        typeId = tokenType.id;
      } else {
        // Validate provided type code
        const tokenType = await this.tokenTypeRepository.findByCode(typeId, tx);
        if (!tokenType) {
          throw new Error(`Invalid token type: ${typeId}`);
        }

        // Forbid creation of fiat tokens
        if (tokenType.code === 'fiat') {
          throw new Error(
            'Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators.'
          );
        }

        typeId = tokenType.id;
      }

      if (!typeId) {
        throw new Error('Token type must be provided or determinable from validation');
      }

      // Check uniqueness
      const existing = await this.tokenRepository.findBySymbolAndType(symbol, typeId, tx);
      if (existing) {
        throw new Error(`Token ${symbol} with this type already exists in the database`);
      }

      // Use validated name if not provided
      const name = input.name || validation.metadata.name || symbol;

      // Create provider metadata
      const providerMetadata = JSON.stringify({
        provider: validation.metadata.provider,
        [validation.metadata.provider]: validation.metadata.providerMetadata,
        validatedAt: new Date().toISOString(),
      });

      // Create token
      const token = await this.tokenRepository.create(
        {
          symbol,
          name,
          typeId,
          decimals: input.decimals || (validation.metadata.type === 'Crypto' ? 18 : 2),
          iconUrl: input.iconUrl || null,
          providerMetadata,
          isActive: input.isActive ?? true,
        },
        tx
      );

      this.assertExists(token, 'Failed to create token');

      this.logInfo('Public token created successfully', {
        tokenId: token.id,
        symbol: token.symbol,
        provider: validation.metadata.provider,
      });

      return {
        token,
        isPrivate: false,
        provider: validation.metadata.provider,
      };
    });
  }

  /**
   * Create a manual price entry for a private token
   */
  private async createManualPrice(
    tokenId: string,
    price: number,
    priceDescription?: string,
    tx?: DatabaseTransaction
  ): Promise<void> {
    try {
      // Get USD token as base currency
      const usdToken = await this.tokenRepository.findBySymbolAndTypeCode('USD', 'fiat', tx);

      if (!usdToken) {
        throw new Error('USD base token not found - required for manual pricing');
      }

      // Create price entry
      await this.tokenPriceRepository.create(
        {
          tokenId,
          baseTokenId: usdToken.id,
          price: price.toString(),
          timestamp: new Date(),
          source: `manual - ${priceDescription || 'Initial price'}`,
        },
        tx
      );

      this.logDebug('Manual price created', {
        tokenId,
        price,
        baseToken: 'USD',
      });
    } catch (error) {
      this.logError('Failed to create manual price', { tokenId, price, error });
      throw error;
    }
  }

  /**
   * Check if a token type is private (editable)
   */
  private isPrivateTokenType(typeCode?: string): boolean {
    return typeCode === 'private-company' || typeCode === 'other';
  }

  /**
   * Map provider token type to database token type
   */
  private mapProviderTypeToDbType(providerType: string): string {
    switch (providerType) {
      case 'Equity':
      case 'ETF':
      case 'Mutual Fund':
      case 'Bond':
      case 'Commodity':
        return 'stock';
      case 'Crypto':
      case 'Cryptocurrency':
        return 'crypto';
      default:
        return 'stock';
    }
  }
}
