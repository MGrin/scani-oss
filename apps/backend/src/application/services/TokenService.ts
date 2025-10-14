import { Container, Service } from 'typedi';
import type { CreateTokenInput, UpdateTokenInput } from '../../domain/dtos/token';
import type { Token, TokenType } from '../../domain/entities';
import { TokenTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import { TokenPriceRepository } from '../../infrastructure/repositories/TokenPriceRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { BaseService } from './BaseService';

/**
 * TokenService
 *
 * Handles all business logic related to token management including:
 * - Token creation with proper provider metadata structure
 * - Atomic token + price creation for private tokens
 * - Token validation and updates
 * - Provider metadata management for CoinGecko and Finnhub
 */
@Service()
export class TokenService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

  constructor() {
    super('TokenService');
  }

  /**
   * Helper to check if a token type is private (user-editable)
   */
  private isPrivateToken(typeCode: string): boolean {
    return typeCode === 'private-company' || typeCode === 'other';
  }

  /**
   * Helper to map provider types to database token types
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

  /**
   * Create a new token with proper validation and metadata handling
   *
   * **CRITICAL BUG FIXES:**
   * 1. Properly structures provider metadata for CoinGecko (with id field)
   * 2. Properly structures provider metadata for Finnhub (with symbol field)
   * 3. Creates manual price entry atomically for private tokens
   * 4. Uses database transaction for atomic operations
   *
   * @param data - Token creation data
   * @param userId - ID of the user creating the token
   * @returns Created token entity
   */
  async createToken(data: CreateTokenInput): Promise<Token> {
    try {
      this.logInfo('Creating new token', {
        symbol: data.symbol,
        typeCode: data.typeCode,
      });

      // Validate required fields
      this.validateRequiredFields(data, ['symbol']);
      this.validateNonEmptyString(data.symbol, 'symbol');

      const symbol = data.symbol.toUpperCase();

      // Handle private token creation
      if (data.typeCode && this.isPrivateToken(data.typeCode)) {
        return await this.createPrivateToken(data, symbol);
      }

      // Handle external token creation
      return await this.createExternalToken(data, symbol);
    } catch (error) {
      throw this.handleError(error, 'createToken');
    }
  }

  /**
   * Create a private token (private-company or other) with manual pricing
   *
   * **BUG FIX**: Creates token and price atomically in a transaction
   */
  private async createPrivateToken(data: CreateTokenInput, symbol: string): Promise<Token> {
    // Private tokens require manual price
    if (!data.manualPrice) {
      throw new Error('Manual price is required for private tokens');
    }

    return await this.withTransaction(async (tx) => {
      // Get token type
      const tokenType = await this.tokenTypeRepository.findByCode(data.typeCode!, tx);
      this.assertExists(tokenType, `Token type '${data.typeCode}' not found`);

      // Check for existing token with same symbol and type
      const existingToken = await this.tokenRepository.findBySymbolAndType(
        symbol,
        tokenType.id,
        tx
      );
      if (existingToken) {
        throw new Error(`Private token ${symbol} already exists`);
      }

      // **BUG FIX**: Properly structure provider metadata for manual tokens
      const providerMetadata = {
        provider: 'manual',
        manual: {
          description: data.description || '',
        },
        validatedAt: new Date().toISOString(),
      };

      // Create the token
      const createdToken = await this.tokenRepository.create(
        {
          symbol,
          name: data.name || symbol,
          typeId: tokenType.id,
          decimals: data.decimals || 2,
          iconUrl: data.iconUrl || null,
          providerMetadata: JSON.stringify(providerMetadata),
          isActive: data.isActive ?? true,
        },
        tx
      );

      this.assertExists(createdToken, 'Failed to create private token');

      // **BUG FIX**: Create manual price entry atomically in same transaction
      // Find USD token for base currency
      const fiatType = await this.tokenTypeRepository.findByCode('fiat', tx);
      this.assertExists(fiatType, 'Fiat token type not found');

      const usdToken = await this.tokenRepository.findBySymbolAndType('USD', fiatType.id, tx);
      this.assertExists(usdToken, 'USD base token not found - required for manual pricing');

      await this.tokenPriceRepository.create(
        {
          tokenId: createdToken.id,
          baseTokenId: usdToken.id,
          price: data.manualPrice?.toString() || '0',
          timestamp: new Date(),
          source: `manual - ${data.priceDescription || 'Initial price'}`,
        },
        tx
      );

      this.logInfo('Private token created successfully with manual price', {
        tokenId: createdToken.id,
        symbol: createdToken.symbol,
        price: data.manualPrice,
      });

      return createdToken;
    });
  }

  /**
   * Create an external token (crypto, stock, etc.) with proper provider metadata
   *
   * **BUG FIX**: Properly structures provider-specific metadata for pricing service
   */
  private async createExternalToken(data: CreateTokenInput, symbol: string): Promise<Token> {
    // Determine token type
    let tokenType: TokenType | null = null;
    if (data.typeCode) {
      // Forbid creation of fiat tokens
      if (data.typeCode === 'fiat') {
        throw new Error(
          'Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators.'
        );
      }

      tokenType = await this.tokenTypeRepository.findByCode(data.typeCode);
      this.assertExists(tokenType, `Token type '${data.typeCode}' not found`);
    }

    // Validate that we have provider metadata for external tokens
    if (!data.providerMetadata || !data.providerMetadata.provider) {
      throw new Error('External tokens must include provider metadata with provider field');
    }

    // If no type code provided, map from provider type if available
    if (!tokenType && data.providerMetadata?.finnhub?.type) {
      const mappedTypeCode = this.mapProviderTypeToDbType(data.providerMetadata.finnhub.type);

      if (mappedTypeCode === 'fiat') {
        throw new Error(
          'Creation of fiat tokens is not allowed. Fiat currencies are managed by system administrators.'
        );
      }

      tokenType = await this.tokenTypeRepository.findByCode(mappedTypeCode);
      this.assertExists(tokenType, `Token type '${mappedTypeCode}' not found`);
    }

    this.assertExists(tokenType, 'Token type must be provided or determinable from metadata');

    // Check for existing token with same symbol and type
    const existingToken = await this.tokenRepository.findBySymbolAndType(symbol, tokenType.id);
    if (existingToken) {
      this.logInfo('Token already exists, returning existing token', {
        tokenId: existingToken.id,
        symbol,
      });
      return existingToken;
    }

    // **CRITICAL BUG FIX**: Properly structure provider metadata for pricing service
    const provider = data.providerMetadata.provider;
    let providerSpecificData: Record<string, unknown> = {};

    if (provider === 'coingecko') {
      // **FIX**: CoinGecko requires the 'id' field for pricing lookups
      const coinGeckoId = data.coinGeckoId || data.providerMetadata?.coingecko?.id;

      if (coinGeckoId) {
        providerSpecificData = {
          id: coinGeckoId,
          symbol: data.providerMetadata?.coingecko?.symbol || symbol,
          name: data.name || data.providerMetadata?.coingecko?.name || symbol,
        };
        this.logInfo('Structured CoinGecko metadata with ID for pricing', {
          symbol,
          coinGeckoId,
        });
      } else {
        // Fallback: use lowercase symbol as ID (CoinGecko convention)
        providerSpecificData = {
          id: symbol.toLowerCase(),
          symbol: symbol,
          name: data.name || symbol,
        };
        this.logWarning('CoinGecko ID not found, using lowercase symbol as fallback', { symbol });
      }
    } else if (provider === 'finnhub') {
      // **FIX**: Finnhub requires the 'symbol' field for pricing lookups
      providerSpecificData = {
        symbol: data.providerMetadata?.finnhub?.symbol || symbol,
        name: data.name || data.providerMetadata?.finnhub?.name || symbol,
        type: data.providerMetadata?.finnhub?.type || 'Equity',
      };
      this.logInfo('Structured Finnhub metadata for pricing', { symbol });
    }

    // **FIX**: Create complete provider metadata structure expected by pricing service
    const providerMetadata = {
      provider,
      [provider]: providerSpecificData,
      validatedAt: new Date().toISOString(),
    };

    // Create the token
    const createdToken = await this.tokenRepository.create({
      symbol,
      name: data.name || symbol,
      typeId: tokenType.id,
      decimals: data.decimals || 2,
      iconUrl: data.iconUrl || null,
      providerMetadata: JSON.stringify(providerMetadata),
      isActive: data.isActive ?? true,
    });

    this.assertExists(createdToken, 'Failed to create external token');

    this.logInfo('External token created successfully', {
      tokenId: createdToken.id,
      symbol: createdToken.symbol,
      provider,
    });

    return createdToken;
  }

  /**
   * Find tokens by multiple symbols
   *
   * @param symbols - Array of token symbols to find
   * @returns Array of found tokens
   */
  async findTokensBySymbols(symbols: string[]): Promise<Token[]> {
    try {
      if (symbols.length === 0) return [];
      return await this.tokenRepository.findBySymbols(symbols);
    } catch (error) {
      throw this.handleError(error, 'findTokensBySymbols');
    }
  }

  /**
   * Update a token (only private tokens can be updated)
   *
   * @param tokenId - ID of the token to update
   * @param data - Token update data
   * @param userId - ID of the user updating the token
   * @returns Updated token entity
   */
  async updateToken(tokenId: string, data: UpdateTokenInput): Promise<Token> {
    try {
      this.logInfo('Updating token', { tokenId, data });

      // Get current token with type
      const currentToken = await this.tokenRepository.findByIdWithType(tokenId);
      this.assertExists(currentToken, `Token with ID ${tokenId} not found`);

      // Only allow updating private tokens (check metadata for type since entity doesn't have typeCode)
      const metadata = JSON.parse(currentToken.providerMetadata || '{}');
      if (metadata.provider !== 'manual') {
        throw new Error('Only manually created tokens can be updated');
      }

      return await this.withTransaction(async (tx) => {
        let updatedToken = currentToken;

        // Update description if provided
        if (data.description !== undefined) {
          const currentMetadata = JSON.parse(currentToken.providerMetadata || '{}');
          const updatedMetadata = {
            ...currentMetadata,
            manual: {
              ...(currentMetadata.manual || {}),
              description: data.description,
            },
            updatedAt: new Date().toISOString(),
          };

          const result = await this.tokenRepository.update(
            tokenId,
            {
              providerMetadata: JSON.stringify(updatedMetadata),
            },
            tx
          );
          this.assertExists(result, 'Failed to update token description');
          // Re-fetch with type info
          const reloaded = await this.tokenRepository.findByIdWithType(tokenId, tx);
          this.assertExists(reloaded, 'Failed to reload updated token');
          updatedToken = reloaded;
        }

        // Update manual price if provided
        if (data.manualPrice !== undefined) {
          // Find USD token for base currency
          const fiatType = await this.tokenTypeRepository.findByCode('fiat', tx);
          this.assertExists(fiatType, 'Fiat token type not found');

          const usdToken = await this.tokenRepository.findBySymbolAndType('USD', fiatType.id, tx);
          this.assertExists(usdToken, 'USD base token not found - required for manual pricing');

          // Insert new price entry
          await this.tokenPriceRepository.create(
            {
              tokenId,
              baseTokenId: usdToken.id,
              price: data.manualPrice.toString(),
              timestamp: new Date(),
              source: `manual_update - ${data.priceDescription || 'Price updated'}`,
            },
            tx
          );

          this.logInfo('Manual price updated for token', {
            tokenId,
            symbol: currentToken.symbol,
            newPrice: data.manualPrice,
          });
        }

        return updatedToken;
      });
    } catch (error) {
      throw this.handleError(error, 'updateToken');
    }
  }

  /**
   * Get token by ID
   */
  async getTokenById(tokenId: string): Promise<Token> {
    try {
      const token = await this.tokenRepository.findById(tokenId);
      this.assertExists(token, `Token with ID ${tokenId} not found`);
      return token;
    } catch (error) {
      throw this.handleError(error, 'getTokenById');
    }
  }

  /**
   * Get token by symbol
   */
  async getTokenBySymbol(symbol: string): Promise<Token | null> {
    try {
      this.validateNonEmptyString(symbol, 'symbol');
      return await this.tokenRepository.findBySymbol(symbol.toUpperCase());
    } catch (error) {
      throw this.handleError(error, 'getTokenBySymbol');
    }
  }

  /**
   * Get token by symbol and type
   */
  async getTokenBySymbolAndType(symbol: string, typeCode: string): Promise<Token | null> {
    try {
      this.validateNonEmptyString(symbol, 'symbol');
      this.validateNonEmptyString(typeCode, 'typeCode');

      const tokenType = await this.tokenTypeRepository.findByCode(typeCode);
      if (!tokenType) {
        return null;
      }

      return await this.tokenRepository.findBySymbolAndType(symbol.toUpperCase(), tokenType.id);
    } catch (error) {
      throw this.handleError(error, 'getTokenBySymbolAndType');
    }
  }

  /**
   * Get all active tokens
   */
  async getAllTokens(limit?: number, offset?: number): Promise<Token[]> {
    try {
      this.logDebug('Fetching all active tokens', { limit, offset });
      return await this.tokenRepository.findAll({ limit, offset });
    } catch (error) {
      throw this.handleError(error, 'getAllTokens');
    }
  }

  /**
   * Get tokens by type code
   */
  async getTokensByType(typeCode: string, _limit?: number, _offset?: number): Promise<Token[]> {
    try {
      this.validateNonEmptyString(typeCode, 'typeCode');

      const tokenType = await this.tokenTypeRepository.findByCode(typeCode);
      this.assertExists(tokenType, `Token type '${typeCode}' not found`);

      // Pass typeCode (not typeId) to repository
      return await this.tokenRepository.findByType(typeCode, undefined);
    } catch (error) {
      throw this.handleError(error, 'getTokensByType');
    }
  }

  /**
   * Check if a token exists
   */
  async tokenExists(symbol: string, typeCode?: string): Promise<boolean> {
    try {
      if (typeCode) {
        const token = await this.getTokenBySymbolAndType(symbol, typeCode);
        return token !== null;
      } else {
        const token = await this.getTokenBySymbol(symbol);
        return token !== null;
      }
    } catch (error) {
      throw this.handleError(error, 'tokenExists');
    }
  }
}
