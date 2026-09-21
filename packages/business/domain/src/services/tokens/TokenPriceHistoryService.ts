import {
  attributeDecimals,
  type Token,
  type TokenMetadata,
  type TokenPriceEditHistory,
} from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import {
  TokenPriceEditHistoryRepository,
  type TokenPriceEditHistoryWithEditor,
} from '../../repositories/TokenPriceEditHistoryRepository';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';

// TokenPriceHistoryService — custom-token (private-company / other) CRUD
// plus manual price-edit-log persistence and audit reads.
@Service()
export class TokenPriceHistoryService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenPriceEditHistoryRepository = Container.get(TokenPriceEditHistoryRepository);

  constructor() {
    super('TokenPriceHistoryService');
  }

  private isPrivateToken(typeCode: string): boolean {
    return typeCode === 'private-company' || typeCode === 'other';
  }

  /**
   * Create a custom token (private-company or other) with an initial manual
   * price, plus the first row in token_price_edit_history — all in one
   * transaction. The token belongs to `userId` and is private to them
   * (SC-1285). Throws if THEY already have a custom token with the same
   * (symbol, typeId); another user's token with that symbol is invisible here
   * and is not a conflict, so the refusal reveals nothing about anybody else.
   */
  async createCustomToken(
    data: {
      symbol: string;
      name: string;
      typeCode: 'private-company' | 'other';
      manualPrice: number;
      baseCurrencyCode: string;
      priceDescription?: string;
      description?: string;
      decimals?: number;
      iconUrl?: string | null;
    },
    userId: string
  ): Promise<Token> {
    try {
      this.validateNonEmptyString(data.symbol, 'symbol');
      this.validateNonEmptyString(data.name, 'name');
      this.validateNonEmptyString(userId, 'userId');
      this.validateNonEmptyString(data.baseCurrencyCode, 'baseCurrencyCode');
      if (!(data.manualPrice > 0)) {
        throw new Error('manualPrice must be a positive number');
      }

      const symbol = data.symbol.toUpperCase();
      const baseSymbol = data.baseCurrencyCode.toUpperCase();

      return await this.withTransaction(async (tx) => {
        const tokenType = await this.tokenTypeRepository.findByCode(data.typeCode, tx);
        this.assertExists(tokenType, `Token type '${data.typeCode}' not found`);

        const existing = await this.tokenRepository.findOwnedBySymbolAndType(
          symbol,
          tokenType.id,
          userId,
          tx
        );
        if (existing) {
          throw new Error(
            `Custom token ${symbol} of type ${data.typeCode} already exists — pick the existing token instead.`
          );
        }

        const fiatType = await this.tokenTypeRepository.findByCode('fiat', tx);
        this.assertExists(fiatType, 'Fiat token type not found');
        const baseCurrencyToken = await this.tokenRepository.findBySymbolAndType(
          baseSymbol,
          fiatType.id,
          tx
        );
        this.assertExists(
          baseCurrencyToken,
          `Base currency '${baseSymbol}' not found as a fiat token`
        );

        const providerMetadata: TokenMetadata = {
          provider: 'manual',
          manual: { description: data.description || '' },
          validatedAt: new Date().toISOString(),
        };

        const createdToken = await this.tokenRepository.create(
          {
            symbol,
            name: data.name,
            typeId: tokenType.id,
            // `user` is the authority here and there is no weaker reading of
            // it: a custom token has no chain and no standard, so its creator
            // is the only party who can answer (`DecimalsSource` in
            // `@scani/db/schema`). This path wrote the number with a NULL
            // source, which is indistinguishable from a row predating the
            // column — so anything later reasoning "NULL means nobody asked"
            // was wrong about exactly the case where somebody did (SC-1116).
            //
            // `attributeDecimals` drops both halves when no decimals was
            // supplied, so an unanswered field stays NULL/NULL rather than
            // claiming a source for a value that does not exist.
            ...attributeDecimals(data.decimals, 'user'),
            iconUrl: data.iconUrl ?? null,
            providerMetadata,
            createdByUserId: userId,
            isActive: true,
          },
          tx
        );
        this.assertExists(createdToken, 'Failed to create custom token');

        const priceStr = data.manualPrice.toString();
        await this.tokenPriceRepository.create(
          {
            tokenId: createdToken.id,
            baseTokenId: baseCurrencyToken.id,
            price: priceStr,
            timestamp: new Date(),
            source: 'manual',
          },
          tx
        );

        await this.tokenPriceEditHistoryRepository.create(
          {
            tokenId: createdToken.id,
            baseTokenId: baseCurrencyToken.id,
            previousPrice: null,
            newPrice: priceStr,
            editedByUserId: userId,
            reason: data.priceDescription ?? 'Initial price',
          },
          tx
        );

        this.logInfo('Custom token created with initial manual price', {
          tokenId: createdToken.id,
          symbol: createdToken.symbol,
          typeCode: data.typeCode,
          baseCurrency: baseSymbol,
          userId,
        });

        return createdToken;
      });
    } catch (error) {
      throw this.handleError(error, 'createCustomToken');
    }
  }

  /**
   * Append a new manual price to a custom token. Only its owner may: for
   * anybody else the token reads as not found, the same error a wrong id
   * gets (SC-1285). Rejects a visible token that is not a custom type
   * (private-company/other). Writes both a new
   * token_prices row (source='manual') and a token_price_edit_history
   * row, atomically.
   */
  async updateCustomTokenPrice(input: {
    tokenId: string;
    newPrice: number;
    baseCurrencyCode: string;
    reason?: string;
    userId: string;
  }): Promise<{
    token: Token;
    previousPrice: string | null;
    previousBaseCurrencyId: string | null;
    newPrice: string;
    newBaseCurrencyId: string;
    historyId: string;
  }> {
    try {
      this.validateNonEmptyString(input.tokenId, 'tokenId');
      this.validateNonEmptyString(input.userId, 'userId');
      this.validateNonEmptyString(input.baseCurrencyCode, 'baseCurrencyCode');
      if (!(input.newPrice > 0)) {
        throw new Error('newPrice must be a positive number');
      }

      const baseSymbol = input.baseCurrencyCode.toUpperCase();

      return await this.withTransaction(async (tx) => {
        const token = await this.tokenRepository.findVisibleById(input.tokenId, input.userId, tx);
        this.assertExists(token, `Token ${input.tokenId} not found`);

        const tokenType = await this.tokenTypeRepository.findById(token.typeId, tx);
        this.assertExists(tokenType, `Token type ${token.typeId} not found`);
        if (!this.isPrivateToken(tokenType.code)) {
          throw new Error(
            `Token ${token.symbol} (${tokenType.code}) is not a custom token — only 'private-company' and 'other' types support manual price editing.`
          );
        }

        const fiatType = await this.tokenTypeRepository.findByCode('fiat', tx);
        this.assertExists(fiatType, 'Fiat token type not found');
        const baseCurrencyToken = await this.tokenRepository.findBySymbolAndType(
          baseSymbol,
          fiatType.id,
          tx
        );
        this.assertExists(
          baseCurrencyToken,
          `Base currency '${baseSymbol}' not found as a fiat token`
        );

        // The previous price could have been recorded in a different
        // fiat base currency — use the manual-any-base lookup so the
        // history entry accurately reflects what changed.
        const latestByMap = await this.tokenPriceRepository.findLatestManualPricesForTokensAnyBase([
          input.tokenId,
        ]);
        const latest = latestByMap.get(input.tokenId) ?? null;
        const previousPrice = latest?.price ?? null;
        const previousBaseCurrencyId = latest?.baseTokenId ?? null;
        const newPriceStr = input.newPrice.toString();

        await this.tokenPriceRepository.create(
          {
            tokenId: token.id,
            baseTokenId: baseCurrencyToken.id,
            price: newPriceStr,
            timestamp: new Date(),
            source: 'manual',
          },
          tx
        );

        const historyRow = await this.tokenPriceEditHistoryRepository.create(
          {
            tokenId: token.id,
            baseTokenId: baseCurrencyToken.id,
            previousPrice,
            newPrice: newPriceStr,
            editedByUserId: input.userId,
            reason: input.reason ?? null,
          },
          tx
        );

        this.logInfo('Custom token price updated', {
          tokenId: token.id,
          symbol: token.symbol,
          previousPrice,
          previousBaseCurrencyId,
          newPrice: newPriceStr,
          newBaseCurrency: baseSymbol,
          userId: input.userId,
        });

        return {
          token,
          previousPrice,
          previousBaseCurrencyId,
          newPrice: newPriceStr,
          newBaseCurrencyId: baseCurrencyToken.id,
          historyId: historyRow.id,
        };
      });
    } catch (error) {
      throw this.handleError(error, 'updateCustomTokenPrice');
    }
  }

  /**
   * The most recent price-edit history entries for a custom token the caller
   * owns — and an empty list for anything else, which is what a token with no
   * history returns too, so it says nothing about another user's token
   * (SC-1285). An editor's email and name are returned only for the caller's
   * own edits: the 2026-09-19 attack edited a token its account did not own,
   * and that row must not hand its owner's reader somebody else's address.
   */
  async getPriceEditHistory(
    tokenId: string,
    userId: string,
    limit = 50
  ): Promise<TokenPriceEditHistoryWithEditor[]> {
    try {
      this.validateNonEmptyString(tokenId, 'tokenId');
      this.validateNonEmptyString(userId, 'userId');
      const token = await this.tokenRepository.findVisibleById(tokenId, userId);
      if (!token || token.createdByUserId !== userId) return [];
      const rows = await this.tokenPriceEditHistoryRepository.findByTokenId(tokenId, limit);
      return rows.map((row) =>
        row.editedByUserId === userId ? row : { ...row, editorEmail: null, editorName: null }
      );
    } catch (error) {
      throw this.handleError(error, 'getPriceEditHistory');
    }
  }

  /**
   * Raw history accessor (no editor join) — used by moderation tooling.
   */
  async getUserPriceEditHistory(userId: string, limit = 100): Promise<TokenPriceEditHistory[]> {
    try {
      this.validateNonEmptyString(userId, 'userId');
      return await this.tokenPriceEditHistoryRepository.findByUserId(userId, limit);
    } catch (error) {
      throw this.handleError(error, 'getUserPriceEditHistory');
    }
  }
}
