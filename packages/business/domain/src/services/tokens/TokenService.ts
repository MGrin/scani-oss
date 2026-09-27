import type { Token, TokenMetadata } from '@scani/db/schema';
import type { DatabaseTransaction } from '@scani/db/transaction';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';
import { TokenIdentityService } from './TokenIdentityService';

// TokenService — token CRUD, canonical reads, and provider-driven
// find-or-create entry points. Federated identity resolution lives in
// TokenIdentityService; custom-token + manual-price-history flows live
// in TokenPriceHistoryService.
@Service()
export class TokenService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly tokenIdentityService = Container.get(TokenIdentityService);

  constructor() {
    super('TokenService');
  }

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

  async getTokenById(tokenId: string): Promise<Token> {
    try {
      const token = await this.tokenRepository.findById(tokenId);
      this.assertExists(token, `Token with ID ${tokenId} not found`);
      return token;
    } catch (error) {
      throw this.handleError(error, 'getTokenById');
    }
  }

  async getTokensByIds(tokenIds: string[]): Promise<Token[]> {
    try {
      return await this.tokenRepository.findByIds(tokenIds);
    } catch (error) {
      throw this.handleError(error, 'getTokensByIds');
    }
  }

  async getTokensByType(typeCode: string, _limit?: number, _offset?: number): Promise<Token[]> {
    try {
      this.validateNonEmptyString(typeCode, 'typeCode');

      const tokenType = await this.tokenTypeRepository.findByCode(typeCode);
      this.assertExists(tokenType, `Token type '${typeCode}' not found`);

      return await this.tokenRepository.findByType(typeCode, undefined);
    } catch (error) {
      throw this.handleError(error, 'getTokensByType');
    }
  }

  /**
   * Generic find-or-create from an integration's token mapping.
   * Works with any token type (crypto / fiat / stock / …) the
   * caller passes via tokenTypeId.
   */
  async findOrCreateTokenFromIntegration(
    tokenMapping: {
      token: {
        symbol: string;
        name: string;
        typeId: string;
        decimals?: number | null;
        iconUrl?: string | null;
        // Structural exchange segment supplied by the provider (IBKR
        // maps listingExchange → 'US' / 'TO' / 'L'). Must reach
        // findOrCreateByIdentity so a balance import resolves the same
        // segmented stock token the tx import does.
        marketSegment?: string | null;
        // Accepts both string-encoded JSON and the schema-typed
        // `TokenMetadata` object — `HoldingSnapshotProjection` passes
        // through whichever the upstream provider produced.
        providerMetadata?: string | TokenMetadata;
      };
      isNew: boolean;
      confidence: number;
    },
    tokenTypeId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ token: Token; wasCreated: boolean }> {
    try {
      this.validateNonEmptyString(tokenTypeId, 'tokenTypeId');

      // Delegate to the EVM-aware identity service so the (chain,
      // contract) tuple drives the lookup. The legacy implementation
      // resolved by `(symbol, typeId)` only, which collapsed the
      // user's per-chain USDC holdings into a single token row —
      // every wallet's USDC holding pointed at whichever USDC
      // contract was inserted first, breaking downstream tx-import
      // resolution because chain-specific tx events couldn't find
      // their per-chain holding.
      const incomingMetadata = tokenMapping.token.providerMetadata
        ? typeof tokenMapping.token.providerMetadata === 'string'
          ? (JSON.parse(tokenMapping.token.providerMetadata) as TokenMetadata)
          : (tokenMapping.token.providerMetadata as TokenMetadata)
        : ({} as TokenMetadata);

      const token = await this.tokenIdentityService.findOrCreateByIdentity(
        {
          symbol: tokenMapping.token.symbol.toUpperCase(),
          name: tokenMapping.token.name,
          typeId: tokenTypeId,
          decimals: tokenMapping.token.decimals ?? null,
          iconUrl: tokenMapping.token.iconUrl ?? null,
          marketSegment: tokenMapping.token.marketSegment ?? undefined,
          providerMetadata: incomingMetadata,
        },
        transaction
      );
      this.assertExists(token, 'Failed to find or create token');
      // findOrCreateByIdentity doesn't expose `wasCreated`. The
      // wrapper's only consumer (HoldingsSyncHelper) ignores this
      // flag in practice; defaulting to false keeps the contract.
      return { token, wasCreated: false };
    } catch (error) {
      throw this.handleError(error, 'findOrCreateTokenFromIntegration');
    }
  }

  /**
   * Crypto-only wrapper around findOrCreateTokenFromIntegration for
   * blockchain/wallet integrations. Validates that the provided
   * cryptoTokenTypeId resolves to the 'crypto' token type.
   */
  async findOrCreateTokenFromIntegrationMapping(
    tokenMapping: {
      token: {
        symbol: string;
        name: string;
        typeId: string;
        decimals?: number | null;
        iconUrl?: string | null;
        providerMetadata?: string | TokenMetadata;
      };
      isNew: boolean;
      confidence: number;
    },
    cryptoTokenTypeId: string,
    transaction?: DatabaseTransaction
  ): Promise<{ token: Token; wasCreated: boolean }> {
    try {
      this.validateNonEmptyString(cryptoTokenTypeId, 'cryptoTokenTypeId');

      const tokenType = await this.tokenTypeRepository.findById(cryptoTokenTypeId, transaction);
      if (!tokenType) {
        throw new Error(`Token type with ID '${cryptoTokenTypeId}' not found`);
      }
      if (tokenType.code !== 'crypto') {
        throw new Error(
          `Blockchain tokens must be of type "crypto". Provided type: ${tokenType.code}`
        );
      }

      return this.findOrCreateTokenFromIntegration(tokenMapping, cryptoTokenTypeId, transaction);
    } catch (error) {
      throw this.handleError(error, 'findOrCreateTokenFromIntegrationMapping');
    }
  }

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

      if (!metadata.name || typeof metadata.name !== 'string') {
        throw new Error('External token metadata must include a name');
      }

      if (!metadata.type || typeof metadata.type !== 'string') {
        throw new Error('External token metadata must include a type');
      }

      const mappedTypeCode = this.mapProviderTypeToDbType(metadata.type as string);

      const tokenType = await this.tokenTypeRepository.findByCode(mappedTypeCode);
      this.assertExists(tokenType, `Token type '${mappedTypeCode}' not found in database`);

      const existingToken = await this.tokenRepository.findBySymbolAndType(symbol, tokenType.id);

      if (existingToken) {
        this.logInfo('Token already exists, returning existing token', {
          tokenId: existingToken.id,
          symbol,
          typeCode: mappedTypeCode,
        });
        return existingToken;
      }

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

      // Preserve `exchangeInfo` from search-result metadata so the
      // pricing router can tell non-US Finnhub listings apart from US
      // ones and route them to Google Sheets (GOOGLEFINANCE).
      const inboundProviderMeta = (metadata.providerMetadata ?? {}) as Record<string, unknown>;
      const exchangeInfo =
        (inboundProviderMeta.exchangeInfo as Record<string, unknown> | undefined) ??
        (metadata.exchangeInfo as Record<string, unknown> | undefined) ??
        undefined;

      const providerMetadataObj: TokenMetadata = {
        provider,
        [provider]: providerSpecificData,
        ...(exchangeInfo ? { exchangeInfo } : {}),
        validatedAt: new Date().toISOString(),
      };

      const tokenData = {
        symbol,
        name: metadata.name as string,
        typeId: tokenType.id,
        decimals: null,
        decimalsSource: null,
        iconUrl: null,
        providerMetadata: providerMetadataObj,
        isActive: true,
      };

      this.logDebug('Creating token with structured metadata', {
        symbol,
        typeCode: mappedTypeCode,
        providerMetadata: providerMetadataObj,
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
