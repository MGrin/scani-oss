import type { CreateTokenInput } from '@scani/shared';
import { Container, Service } from 'typedi';
import type { DatabaseTransaction } from '../database/transaction';
import type { Token, TokenType } from '../domain/entities';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { BaseService } from './BaseService';
import { ScamTokenDetectionService } from './ScamTokenDetectionService';

@Service()
export class TokenService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly scamDetectionService = Container.get(ScamTokenDetectionService);

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
    if (!data.providerMetadata?.provider) {
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
   * Get multiple tokens by IDs
   */
  async getTokensByIds(tokenIds: string[]): Promise<Token[]> {
    try {
      return await this.tokenRepository.findByIds(tokenIds);
    } catch (error) {
      throw this.handleError(error, 'getTokensByIds');
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
   * Find or create token from blockchain data
   *
   * IMPORTANT: Tokens from blockchain services MUST always be of type 'crypto'.
   * This method enforces this requirement by validating the provided typeId.
   */
  async findOrCreateTokenFromBlockchain(tokenData: {
    symbol: string;
    name: string;
    decimals: number;
    typeId: string;
    iconUrl?: string | null;
    isNative?: boolean;
    tokenAddress?: string;
    chainName: string;
    coinGeckoId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Token> {
    try {
      // Validate that we have a valid crypto token type ID
      this.validateNonEmptyString(tokenData.typeId, 'typeId');

      // Verify the provided token type exists
      const tokenType = await this.tokenTypeRepository.findById(tokenData.typeId);
      if (!tokenType) {
        throw new Error(`Token type with ID '${tokenData.typeId}' not found`);
      }
      if (tokenType.code !== 'crypto') {
        throw new Error(
          `Blockchain tokens must be of type "crypto". Provided type: ${tokenType.code}`
        );
      }

      // Try to find existing token
      let token = await this.tokenRepository.findBySymbolAndType(
        tokenData.symbol.toUpperCase(),
        tokenData.typeId
      );

      if (!token) {
        // Create new token
        token = await this.tokenRepository.create({
          symbol: tokenData.symbol.toUpperCase(),
          name: tokenData.name,
          typeId: tokenData.typeId,
          decimals: tokenData.decimals,
          iconUrl: tokenData.iconUrl || null,
          providerMetadata: JSON.stringify({
            isNative: tokenData.isNative,
            tokenAddress: tokenData.tokenAddress,
            chain: tokenData.chainName,
            ...(tokenData.coinGeckoId && { coinGeckoId: tokenData.coinGeckoId }),
            ...(tokenData.metadata && { chainMetadata: tokenData.metadata }),
          }),
          isActive: true,
        });

        this.assertExists(token, 'Failed to create token');
        this.logInfo('Token created from blockchain data', {
          tokenId: token.id,
          symbol: token.symbol,
        });
      }

      return token;
    } catch (error) {
      throw this.handleError(error, 'findOrCreateTokenFromBlockchain');
    }
  }

  /**
   * Find or create token from integration token mapping
   * Used by use cases that work with integration holdings (all types: crypto, fiat, stock, etc.)
   *
   * This is a generic method that works with any token type based on the tokenMapping
   * result from integration.mapToken().
   *
   * @param tokenMapping - Token mapping from integration
   * @param tokenTypeId - The token type ID to use (can be crypto, fiat, stock, etc.)
   * @param defaultDecimals - Default decimals if not provided in token mapping
   */
  async findOrCreateTokenFromIntegration(
    tokenMapping: {
      token: {
        symbol: string;
        name: string;
        typeId: string;
        decimals?: number;
        iconUrl?: string | null;
        providerMetadata?: string;
      };
      isNew: boolean;
      confidence: number;
    },
    tokenTypeId: string,
    defaultDecimals = 18,
    transaction?: DatabaseTransaction
  ): Promise<{ token: Token; wasCreated: boolean }> {
    try {
      // Validate that we have a valid token type ID
      this.validateNonEmptyString(tokenTypeId, 'tokenTypeId');

      // Verify the provided token type exists
      const tokenType = await this.tokenTypeRepository.findById(tokenTypeId, transaction);
      if (!tokenType) {
        throw new Error(`Token type with ID '${tokenTypeId}' not found`);
      }

      // Try to find existing token by symbol and type
      let token = await this.tokenRepository.findBySymbolAndType(
        tokenMapping.token.symbol,
        tokenTypeId,
        transaction
      );

      if (token) {
        // Update metadata if we have new information
        const existingMetadata = JSON.parse(token.providerMetadata || '{}');
        const newMetadata = JSON.parse(tokenMapping.token.providerMetadata || '{}');
        const updatedMetadata = {
          ...existingMetadata,
          ...newMetadata,
        };

        token = await this.tokenRepository.update(
          token.id,
          {
            providerMetadata: JSON.stringify(updatedMetadata),
          },
          transaction
        );

        this.assertExists(token, 'Failed to update token');
        return { token, wasCreated: false };
      }

      // Calculate scam probability only for crypto tokens
      // Note: Price data is not available at token creation time; it's fetched separately by pricing services.
      // This means initial scam detection relies on symbol/name patterns rather than price volatility.
      let scamProbability = 0;
      if (tokenType.code === 'crypto') {
        scamProbability = this.scamDetectionService.calculateScamProbability(
          tokenMapping.token.symbol,
          tokenMapping.token.name,
          new Date(), // Token is being created now
          false // No price data available yet
        );
      }

      // Create new token
      token = await this.tokenRepository.create(
        {
          symbol: tokenMapping.token.symbol.toUpperCase(),
          name: tokenMapping.token.name,
          typeId: tokenTypeId,
          decimals: tokenMapping.token.decimals ?? defaultDecimals,
          iconUrl: tokenMapping.token.iconUrl || null,
          providerMetadata: tokenMapping.token.providerMetadata || '{}',
          isScamProbability: scamProbability,
          isActive: true,
        },
        transaction
      );

      this.assertExists(token, 'Failed to create token');
      this.logDebug('Token created from integration mapping', {
        tokenId: token.id,
        symbol: token.symbol,
        tokenType: tokenType.code,
        scamProbability: tokenType.code === 'crypto' ? scamProbability.toFixed(2) : 'N/A',
      });

      return { token, wasCreated: true };
    } catch (error) {
      throw this.handleError(error, 'findOrCreateTokenFromIntegration');
    }
  }

  /**
   * Find or create token from integration token mapping (for blockchain/wallet integrations)
   * Used by blockchain-specific use cases (wallet imports, blockchain sync)
   *
   * IMPORTANT: Tokens from blockchain integrations MUST always be of type 'crypto'.
   * This method enforces this requirement by validating the provided cryptoTokenTypeId.
   *
   * This is a wrapper around findOrCreateTokenFromIntegration with crypto-only validation.
   *
   * @param tokenMapping - Token mapping from blockchain integration
   * @param cryptoTokenTypeId - The crypto token type ID (must be 'crypto' type)
   * @param defaultDecimals - Default decimals if not provided (typically 18 for EVM chains)
   * @param transaction - Optional database transaction
   */
  async findOrCreateTokenFromIntegrationMapping(
    tokenMapping: {
      token: {
        symbol: string;
        name: string;
        typeId: string;
        decimals?: number;
        iconUrl?: string | null;
        providerMetadata?: string;
      };
      isNew: boolean;
      confidence: number;
    },
    cryptoTokenTypeId: string,
    defaultDecimals = 18,
    transaction?: DatabaseTransaction
  ): Promise<{ token: Token; wasCreated: boolean }> {
    try {
      // Validate that we have a valid crypto token type ID
      this.validateNonEmptyString(cryptoTokenTypeId, 'cryptoTokenTypeId');

      // Verify the provided token type is 'crypto' to enforce blockchain token requirement
      const tokenType = await this.tokenTypeRepository.findById(cryptoTokenTypeId, transaction);
      if (!tokenType) {
        throw new Error(`Token type with ID '${cryptoTokenTypeId}' not found`);
      }
      if (tokenType.code !== 'crypto') {
        throw new Error(
          `Blockchain tokens must be of type "crypto". Provided type: ${tokenType.code}`
        );
      }

      // Delegate to the generic method
      return this.findOrCreateTokenFromIntegration(
        tokenMapping,
        cryptoTokenTypeId,
        defaultDecimals,
        transaction
      );
    } catch (error) {
      throw this.handleError(error, 'findOrCreateTokenFromIntegrationMapping');
    }
  }

  /**
   * Create multiple tokens from external providers in a batch operation
   */
  async createManyFromExternal(
    tokensData: Array<{
      externalId: string;
      symbol: string;
      metadata: Record<string, unknown>;
      provider: 'finnhub' | 'coingecko' | 'defillama';
    }>,
    _userId: string
  ): Promise<Array<Token & { externalId?: string }>> {
    try {
      this.logInfo('Creating tokens from external providers (batch)', {
        count: tokensData.length,
        symbols: tokensData.map((t) => t.symbol),
      });

      // Validate all metadata upfront
      for (const token of tokensData) {
        if (!token.metadata.name || typeof token.metadata.name !== 'string') {
          throw new Error(`External token metadata for ${token.symbol} must include a name`);
        }
        if (!token.metadata.type || typeof token.metadata.type !== 'string') {
          throw new Error(`External token metadata for ${token.symbol} must include a type`);
        }
      }

      // Get all unique token type codes needed
      const uniqueTypeCodes = [
        ...new Set(tokensData.map((t) => this.mapProviderTypeToDbType(t.metadata.type as string))),
      ];

      // Fetch all token types
      const tokenTypes = await this.tokenTypeRepository.findByCodes(uniqueTypeCodes);
      const tokenTypeMap = new Map(tokenTypes.map((tt) => [tt.code, tt]));

      // Verify all types exist
      for (const code of uniqueTypeCodes) {
        if (!tokenTypeMap.has(code)) {
          throw new Error(`Token type '${code}' not found in database`);
        }
      }

      // Check existing tokens
      const symbolTypeIdPairs = tokensData.map((t) => {
        const typeCode = this.mapProviderTypeToDbType(t.metadata.type as string);
        const typeId = tokenTypeMap.get(typeCode)!.id;
        return { symbol: t.symbol, typeId };
      });

      const existingTokens = await this.tokenRepository.findBySymbolTypePairs(symbolTypeIdPairs);
      const existingTokenMap = new Map(existingTokens.map((t) => [`${t.symbol}-${t.typeId}`, t]));

      // Create externalId mapping for input tokens
      const externalIdMap = new Map(
        tokensData.map((t) => {
          const typeCode = this.mapProviderTypeToDbType(t.metadata.type as string);
          const typeId = tokenTypeMap.get(typeCode)!.id;
          return [`${t.symbol}-${typeId}`, t.externalId];
        })
      );

      // Prepare tokens to create
      const tokensToCreate = tokensData
        .map((token) => {
          const typeCode = this.mapProviderTypeToDbType(token.metadata.type as string);
          const tokenType = tokenTypeMap.get(typeCode)!;
          const key = `${token.symbol}-${tokenType.id}`;

          if (existingTokenMap.has(key)) {
            return null;
          }

          let providerSpecificData: Record<string, unknown> = {};

          if (token.provider === 'coingecko') {
            const coinGeckoId =
              (token.metadata.providerMetadata as Record<string, unknown>)?.id ||
              (token.metadata as Record<string, unknown>).coinGeckoId ||
              (token.metadata as Record<string, unknown>).id ||
              token.symbol.toLowerCase();

            providerSpecificData = {
              id: coinGeckoId as string,
              symbol: token.symbol,
              name: token.metadata.name,
            };
          } else if (token.provider === 'finnhub') {
            const finnhubSymbol =
              (token.metadata.providerMetadata as Record<string, unknown>)?.symbol ||
              (token.metadata as Record<string, unknown>).finnhubSymbol ||
              token.symbol;

            providerSpecificData = {
              symbol: finnhubSymbol as string,
              name: token.metadata.name,
              type: token.metadata.type,
            };
          }

          const providerMetadata = JSON.stringify({
            provider: token.provider,
            [token.provider]: providerSpecificData,
            validatedAt: new Date().toISOString(),
          });

          return {
            symbol: token.symbol,
            name: token.metadata.name as string,
            typeId: tokenType.id,
            decimals: typeCode === 'crypto' ? 18 : 2,
            iconUrl: null,
            providerMetadata,
            isActive: true,
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);

      let createdTokens: Token[] = [];

      // Batch insert if there are tokens to create
      if (tokensToCreate.length > 0) {
        createdTokens = await this.tokenRepository.createMany(tokensToCreate);

        this.logInfo('Batch created external tokens', {
          created: createdTokens.length,
          symbols: createdTokens.map((t) => t.symbol),
        });
      }

      // Combine existing and created tokens with externalId
      const allTokens = [
        ...Array.from(existingTokenMap.values()).map((token) => ({
          ...token,
          externalId: externalIdMap.get(`${token.symbol}-${token.typeId}`),
        })),
        ...createdTokens.map((token) => ({
          ...token,
          externalId: externalIdMap.get(`${token.symbol}-${token.typeId}`),
        })),
      ];

      this.logInfo('Batch token creation complete', {
        requested: tokensData.length,
        existing: existingTokenMap.size,
        created: createdTokens.length,
        total: allTokens.length,
      });

      return allTokens;
    } catch (error) {
      throw this.handleError(error, 'createManyFromExternal');
    }
  }

  /**
   * Create a single token from external provider metadata
   */
  async createFromExternal(
    symbol: string,
    metadata: Record<string, unknown>,
    provider: 'finnhub' | 'coingecko',
    _userId: string
  ): Promise<Token> {
    try {
      this.logInfo('Creating token from external provider', {
        symbol,
        provider,
        metadata,
      });

      // Validate the metadata has the required fields
      if (!metadata.name || typeof metadata.name !== 'string') {
        throw new Error('External token metadata must include a name');
      }

      if (!metadata.type || typeof metadata.type !== 'string') {
        throw new Error('External token metadata must include a type');
      }

      // Map provider type to our token type
      const mappedTypeCode = this.mapProviderTypeToDbType(metadata.type as string);

      // Get token type
      const tokenType = await this.tokenTypeRepository.findByCode(mappedTypeCode);
      this.assertExists(tokenType, `Token type '${mappedTypeCode}' not found in database`);

      // Check if token already exists with this symbol and type
      const existingToken = await this.tokenRepository.findBySymbolAndType(symbol, tokenType.id);

      if (existingToken) {
        this.logInfo('Token already exists, returning existing token', {
          tokenId: existingToken.id,
          symbol,
          typeCode: mappedTypeCode,
        });
        return existingToken;
      }

      // Create proper provider metadata structure for pricing service
      let providerSpecificData: Record<string, unknown> = {};

      if (provider === 'coingecko') {
        const coinGeckoId =
          (metadata.providerMetadata as Record<string, unknown>)?.id ||
          (metadata as Record<string, unknown>).coinGeckoId ||
          (metadata as Record<string, unknown>).id;

        if (coinGeckoId && typeof coinGeckoId === 'string') {
          providerSpecificData = {
            id: coinGeckoId,
            symbol: symbol,
            name: metadata.name,
          };
          this.logInfo('Structured CoinGecko metadata with ID for pricing', {
            symbol,
            coinGeckoId,
          });
        } else {
          providerSpecificData = {
            id: symbol.toLowerCase(),
            symbol: symbol,
            name: metadata.name,
          };
          this.logWarning(
            'CoinGecko ID not found in metadata, using lowercase symbol as fallback',
            {
              symbol,
            }
          );
        }
      } else if (provider === 'finnhub') {
        const finnhubSymbol =
          (metadata.providerMetadata as Record<string, unknown>)?.symbol ||
          (metadata as Record<string, unknown>).finnhubSymbol ||
          symbol;

        providerSpecificData = {
          symbol: finnhubSymbol,
          name: metadata.name,
          type: metadata.type,
        };
        this.logInfo('Structured Finnhub metadata for pricing', { symbol, finnhubSymbol });
      }

      // Create the complete provider metadata structure
      const providerMetadataStr = JSON.stringify({
        provider,
        [provider]: providerSpecificData,
        validatedAt: new Date().toISOString(),
      });

      const tokenData = {
        symbol,
        name: metadata.name as string,
        typeId: tokenType.id,
        decimals: mappedTypeCode === 'crypto' ? 18 : 2,
        iconUrl: null,
        providerMetadata: providerMetadataStr,
        isActive: true,
      };

      this.logDebug('Creating token with structured metadata', {
        symbol,
        typeCode: mappedTypeCode,
        providerMetadata: providerMetadataStr,
      });

      const createdToken = await this.tokenRepository.create(tokenData);
      this.assertExists(createdToken, 'Failed to create external token - database insert failed');
      this.assertExists(
        createdToken.id,
        'Failed to create external token - no ID assigned by database'
      );

      this.logInfo('External token created successfully with valid ID', {
        tokenId: createdToken.id,
        symbol: createdToken.symbol,
        name: createdToken.name,
        provider,
        typeId: tokenType.id,
      });

      return createdToken;
    } catch (error) {
      throw this.handleError(error, 'createFromExternal');
    }
  }
}
