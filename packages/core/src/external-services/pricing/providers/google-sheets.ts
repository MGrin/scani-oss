import { eq, inArray } from 'drizzle-orm';
import { google } from 'googleapis';
import type { Logger } from 'pino';
import { config } from '../../../config/pricing';
import type { DbType } from '../../../database/connection';
import * as schema from '../../../database/schema';
import { PROVIDER_CONFIGS } from '../provider-config';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import type { RateLimiter } from '../utils';
import {
  fetchWithTimeout,
  isValidPrice,
  parseInternationalNumber,
  sanitizeForGoogleFinanceSymbol,
} from '../utils';
import type {
  ConvertPriceFn,
  CreateFailureResultFn,
  PricingProvider,
  ProviderExecutionContext,
} from './base';

type SheetsLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

interface CachedExchangeInfo {
  currency: string;
  exchange: string;
  mic: string;
}

interface GoogleSheetsProviderDependencies {
  db: DbType;
  rateLimiter: RateLimiter;
  finnhubRateLimiter: RateLimiter;
  convertPrice: ConvertPriceFn;
  createFailureResult: CreateFailureResultFn;
  logger: SheetsLogger;
}

export class GoogleSheetsProvider implements PricingProvider {
  readonly key = 'googleSheets';

  private readonly db: DbType;
  private readonly rateLimiter: RateLimiter;
  private readonly finnhubRateLimiter: RateLimiter;
  private readonly convertPriceFn: ConvertPriceFn;
  private readonly createFailureResult: CreateFailureResultFn;
  private readonly logger: SheetsLogger;
  private readonly spreadsheetId: string | null;
  private googleSheetsCredentials: Record<string, unknown> | null = null;
  private readonly available: boolean;
  private readonly GOOGLE_SHEETS_LOCK_ID = 123456789;

  constructor(deps: GoogleSheetsProviderDependencies) {
    this.db = deps.db;
    this.rateLimiter = deps.rateLimiter;
    this.finnhubRateLimiter = deps.finnhubRateLimiter;
    this.convertPriceFn = deps.convertPrice;
    this.createFailureResult = deps.createFailureResult;
    this.logger = deps.logger;
    this.spreadsheetId = process.env.GOOGLE_SHEETS_ID || null;
    this.available = this.initializeCredentials();
  }

  isAvailable(): boolean {
    return this.available;
  }

  async fetchPrices(
    tokensWithMetadata: TokenWithProvider[],
    { baseCurrency, timestamp }: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]> {
    if (!this.available || !this.googleSheetsCredentials || !this.spreadsheetId) {
      return [];
    }

    if (!this.isLivePrice(timestamp)) {
      this.logger.debug('Google Sheets only supports live prices, timestamp too old');
      return [];
    }

    const baseCurrencySymbol = baseCurrency.symbol;
    const results: ProviderPriceResult[] = [];

    this.logger.info(
      {
        tokenCount: tokensWithMetadata.length,
        baseCurrency: baseCurrencySymbol,
      },
      'Fetching prices from Google Sheets'
    );

    try {
      const auth = new google.auth.GoogleAuth({
        credentials: this.googleSheetsCredentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const sheets = google.sheets({ version: 'v4', auth });

      const tokensWithExistingRows: Array<{
        token: schema.Token;
        rowNumber: number;
      }> = [];
      const tokensToAdd: Array<{
        token: schema.Token;
        exchangeInfo: CachedExchangeInfo | null;
      }> = [];

      for (const { token } of tokensWithMetadata) {
        let existingRowNumber: number | null = null;
        let cachedExchangeInfo: CachedExchangeInfo | null = null;

        try {
          const [freshToken] = await this.db
            .select({ providerMetadata: schema.tokens.providerMetadata })
            .from(schema.tokens)
            .where(eq(schema.tokens.id, token.id))
            .limit(1);

          const metadata = JSON.parse(freshToken?.providerMetadata || '{}');
          existingRowNumber = metadata.googleSheets?.rowNumber || null;
          cachedExchangeInfo = metadata.exchangeInfo || null;
        } catch {
          this.logger.debug({ tokenId: token.id }, 'No valid metadata found for token');
        }

        if (existingRowNumber) {
          tokensWithExistingRows.push({ token, rowNumber: existingRowNumber });
        } else {
          tokensToAdd.push({ token, exchangeInfo: cachedExchangeInfo });
        }
      }

      if (tokensWithExistingRows.length > 0) {
        this.logger.info(
          { existingTokenCount: tokensWithExistingRows.length },
          'Google Sheets: Reading prices for existing tokens in parallel'
        );

        const ranges = tokensWithExistingRows.map(({ rowNumber }) => `B${rowNumber}`);

        try {
          const batchResponse = await this.rateLimiter.execute(async () => {
            return await sheets.spreadsheets.values.batchGet({
              spreadsheetId: this.spreadsheetId!,
              ranges,
            });
          });

          const valueRanges = batchResponse.data.valueRanges || [];

          for (let i = 0; i < tokensWithExistingRows.length; i++) {
            const tokenRow = tokensWithExistingRows[i];
            if (!tokenRow) continue;

            const { token, rowNumber } = tokenRow;
            const priceValue = valueRanges[i]?.values?.[0]?.[0];

            if (isValidPrice(priceValue)) {
              const parsedPrice = parseInternationalNumber(priceValue);
              let price = parsedPrice!.toString();

              try {
                const metadata = JSON.parse(token.providerMetadata || '{}');
                const exchangeInfo = metadata.exchangeInfo as CachedExchangeInfo;

                if (exchangeInfo?.currency && exchangeInfo.currency !== baseCurrencySymbol) {
                  const converted = await this.convertPriceFn(
                    price,
                    exchangeInfo.currency,
                    baseCurrencySymbol,
                    timestamp
                  );

                  if (converted !== '0') {
                    price = converted;
                    this.logger.debug(
                      {
                        symbol: token.symbol,
                        originalPrice: priceValue,
                        convertedPrice: price,
                        fromCurrency: exchangeInfo.currency,
                        toCurrency: baseCurrencySymbol,
                      },
                      'Google Sheets: Price converted to base currency'
                    );
                  } else {
                    this.logger.warn(
                      {
                        symbol: token.symbol,
                        fromCurrency: exchangeInfo.currency,
                        toCurrency: baseCurrencySymbol,
                      },
                      'Google Sheets: Currency conversion failed'
                    );
                  }
                }
              } catch (error) {
                this.logger.debug(
                  { symbol: token.symbol, error },
                  'Google Sheets: No currency conversion info available, using price as-is'
                );
              }

              results.push({
                tokenId: token.id,
                price,
                timestamp,
                source: PROVIDER_CONFIGS.googleSheets.name,
              });

              this.logger.debug(
                { symbol: token.symbol, price, row: rowNumber },
                'Google Sheets: Found existing price'
              );
            } else {
              this.logger.debug(
                { symbol: token.symbol, priceValue, row: rowNumber },
                'Google Sheets: Invalid price value'
              );
              results.push(
                this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  new Error(`Invalid price value: ${priceValue}`),
                  { dataEmpty: false }
                )
              );
            }
          }
        } catch (error) {
          this.logger.error(
            { error, tokenCount: tokensWithExistingRows.length },
            'Google Sheets: Batch read failed, falling back to individual reads'
          );

          const individualReadPromises = tokensWithExistingRows.map(
            async ({ token, rowNumber }) => {
              try {
                const priceResponse = await this.rateLimiter.execute(async () => {
                  return await sheets.spreadsheets.values.get({
                    spreadsheetId: this.spreadsheetId!,
                    range: `B${rowNumber}`,
                  });
                });

                const priceValue = priceResponse.data.values?.[0]?.[0];

                if (isValidPrice(priceValue)) {
                  const parsedPrice = parseInternationalNumber(priceValue);
                  let price = parsedPrice!.toString();

                  try {
                    const metadata = JSON.parse(token.providerMetadata || '{}');
                    const exchangeInfo = metadata.exchangeInfo as CachedExchangeInfo;

                    if (exchangeInfo?.currency && exchangeInfo.currency !== baseCurrencySymbol) {
                      const converted = await this.convertPriceFn(
                        price,
                        exchangeInfo.currency,
                        baseCurrencySymbol,
                        timestamp
                      );

                      if (converted !== '0') {
                        price = converted;
                      }
                    }
                  } catch (error) {
                    this.logger.debug(
                      { symbol: token.symbol, error },
                      'Google Sheets: No currency conversion for individual read'
                    );
                  }

                  return {
                    tokenId: token.id,
                    price,
                    timestamp,
                    source: PROVIDER_CONFIGS.googleSheets.name,
                  };
                }

                return this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  new Error(`Invalid price value: ${priceValue}`),
                  { dataEmpty: false }
                );
              } catch (err) {
                this.logger.warn(
                  { symbol: token.symbol, error: err, row: rowNumber },
                  'Google Sheets: Failed to read price from existing row'
                );
                return this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  err,
                  { dataEmpty: false }
                );
              }
            }
          );

          const individualResults = await Promise.all(individualReadPromises);
          results.push(...individualResults);
        }
      }

      if (tokensToAdd.length > 0) {
        const tokensNeedingExchangeInfo = tokensToAdd.filter((t) => !t.exchangeInfo).length;
        const tokensWithCachedInfo = tokensToAdd.length - tokensNeedingExchangeInfo;

        this.logger.info(
          {
            newTokenCount: tokensToAdd.length,
            needExchangeInfo: tokensNeedingExchangeInfo,
            haveCachedInfo: tokensWithCachedInfo,
          },
          'Processing new tokens for Google Sheets - optimized exchange info fetching'
        );

        const exchangeInfoPromises = tokensToAdd.map(async (tokenData) => {
          if (!tokenData.exchangeInfo) {
            tokenData.exchangeInfo = await this.getTokenExchangeInfo(tokenData.token);
          } else {
            this.logger.debug(
              { tokenId: tokenData.token.id, symbol: tokenData.token.symbol },
              'Using cached exchange info for new Google Sheets token'
            );
          }
          return tokenData;
        });

        await Promise.all(exchangeInfoPromises);

        let nextRow = 1;
        const newRows: string[][] = [];

        await this.withGoogleSheetsLock(async () => {
          const sheetInfoResponse = await this.rateLimiter.execute(async () => {
            return await sheets.spreadsheets.values.get({
              spreadsheetId: this.spreadsheetId!,
              range: 'A:A',
            });
          });
          const currentRows = sheetInfoResponse.data.values || [];
          nextRow = currentRows.length + 1;

          this.logger.info(
            {
              currentSheetRows: currentRows.length,
              nextRowToUse: nextRow,
              tokensToAdd: tokensToAdd.length,
            },
            'Google Sheets: Assigning row numbers with advisory lock protection'
          );

          for (let index = 0; index < tokensToAdd.length; index++) {
            const tokenToAdd = tokensToAdd[index];
            if (!tokenToAdd) continue;

            const { token, exchangeInfo } = tokenToAdd;
            const symbol = sanitizeForGoogleFinanceSymbol(token.symbol.toUpperCase());
            const rowNumber = nextRow + index;

            const formula = this.createGoogleFinanceFormula(symbol, exchangeInfo);

            newRows.push([symbol, formula, new Date().toISOString()]);

            await this.updateTokenGoogleSheetsMetadata(token.id, rowNumber, exchangeInfo);

            this.logger.debug(
              {
                tokenId: token.id,
                symbol,
                assignedRow: rowNumber,
              },
              'Google Sheets: Assigned row number to token'
            );
          }

          await this.rateLimiter.execute(async () => {
            return await sheets.spreadsheets.values.append({
              spreadsheetId: this.spreadsheetId!,
              range: 'A:C',
              valueInputOption: 'USER_ENTERED',
              requestBody: {
                values: newRows,
              },
            });
          });

          this.logger.info(
            {
              count: newRows.length,
              startingRow: nextRow,
              endingRow: nextRow + newRows.length - 1,
            },
            'Google Sheets: Added new tokens with row assignment protection'
          );
        });

        this.logger.info({ count: newRows.length }, 'Google Sheets: Added new tokens');

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const newTokenRanges = tokensToAdd.map((_, index) => `B${nextRow + index}`);

        try {
          const batchReadResponse = await this.rateLimiter.execute(async () => {
            return await sheets.spreadsheets.values.batchGet({
              spreadsheetId: this.spreadsheetId!,
              ranges: newTokenRanges,
            });
          });

          const valueRanges = batchReadResponse.data.valueRanges || [];

          for (let index = 0; index < tokensToAdd.length; index++) {
            const tokenData = tokensToAdd[index];
            if (!tokenData) continue;

            const { token, exchangeInfo } = tokenData;
            const rowNumber = nextRow + index;
            const priceValue = valueRanges[index]?.values?.[0]?.[0];

            if (isValidPrice(priceValue)) {
              const parsedPrice = parseInternationalNumber(priceValue);
              let price = parsedPrice!.toString();

              if (exchangeInfo?.currency && exchangeInfo.currency !== baseCurrencySymbol) {
                const originalPrice = price;
                price = await this.convertPriceFn(
                  price,
                  exchangeInfo.currency,
                  baseCurrencySymbol,
                  timestamp
                );

                if (price === '0') {
                  this.logger.warn(
                    {
                      symbol: token.symbol,
                      fromCurrency: exchangeInfo.currency,
                      toCurrency: baseCurrencySymbol,
                    },
                    'Google Sheets: Currency conversion failed for new token'
                  );
                } else {
                  this.logger.debug(
                    {
                      symbol: token.symbol,
                      originalPrice,
                      convertedPrice: price,
                      fromCurrency: exchangeInfo.currency,
                      toCurrency: baseCurrencySymbol,
                    },
                    'Google Sheets: New token price converted to base currency'
                  );
                }
              }

              results.push({
                tokenId: token.id,
                price,
                timestamp,
                source: PROVIDER_CONFIGS.googleSheets.name,
              });

              this.logger.debug(
                { symbol: token.symbol, price, row: rowNumber },
                'Google Sheets: Got price for new token'
              );
            } else {
              this.logger.debug(
                { symbol: token.symbol, priceValue, row: rowNumber },
                'Google Sheets: No valid price for new token'
              );
              results.push(
                this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  new Error(`No valid price returned: ${priceValue}`),
                  { dataEmpty: false }
                )
              );
            }
          }
        } catch (error) {
          this.logger.error(
            { error, tokenCount: tokensToAdd.length },
            'Google Sheets: Batch read of new tokens failed, falling back to individual reads'
          );

          const individualReadPromises = tokensToAdd.map(async ({ token, exchangeInfo }, index) => {
            const rowNumber = nextRow + index;

            try {
              const priceResponse = await this.rateLimiter.execute(async () => {
                return await sheets.spreadsheets.values.get({
                  spreadsheetId: this.spreadsheetId!,
                  range: `B${rowNumber}`,
                });
              });

              const priceValue = priceResponse.data.values?.[0]?.[0];

              if (isValidPrice(priceValue)) {
                const parsedPrice = parseInternationalNumber(priceValue);
                let price = parsedPrice!.toString();

                if (exchangeInfo?.currency && exchangeInfo.currency !== baseCurrencySymbol) {
                  const originalPrice = price;
                  price = await this.convertPriceFn(
                    price,
                    exchangeInfo.currency,
                    baseCurrencySymbol,
                    timestamp
                  );

                  if (price !== '0') {
                    this.logger.debug(
                      {
                        symbol: token.symbol,
                        originalPrice,
                        convertedPrice: price,
                        fromCurrency: exchangeInfo.currency,
                        toCurrency: baseCurrencySymbol,
                      },
                      'Google Sheets: New token individual read price converted'
                    );
                  }
                }

                return {
                  tokenId: token.id,
                  price,
                  timestamp,
                  source: PROVIDER_CONFIGS.googleSheets.name,
                };
              }

              return this.createFailureResult(
                token.id,
                timestamp,
                PROVIDER_CONFIGS.googleSheets.name,
                new Error(`No valid price returned: ${priceValue}`),
                { dataEmpty: false }
              );
            } catch (err) {
              this.logger.warn(
                { symbol: token.symbol, error: err, row: rowNumber },
                'Google Sheets: Failed to read new token price'
              );
              return this.createFailureResult(
                token.id,
                timestamp,
                PROVIDER_CONFIGS.googleSheets.name,
                err,
                { dataEmpty: false }
              );
            }
          });

          const individualResults = await Promise.all(individualReadPromises);
          results.push(...individualResults);
        }
      }
    } catch (error) {
      this.logger.error({ error, provider: 'googleSheets' }, 'Google Sheets API failed');

      for (const tokenData of tokensWithMetadata) {
        const token = tokenData.token;
        try {
          results.push(
            this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.googleSheets.name,
              error,
              { dataEmpty: false }
            )
          );
        } catch (nonCacheableError) {
          this.logger.debug(
            { error: nonCacheableError, tokenId: token.id },
            'Google Sheets: Skipping non-cacheable error'
          );
        }
      }
    }

    return results;
  }

  async filterEligibleTokens(tokensToFilter: schema.Token[]): Promise<schema.Token[]> {
    if (tokensToFilter.length === 0) {
      return [];
    }

    this.logger.debug(
      {
        totalTokens: tokensToFilter.length,
        tokens: tokensToFilter.map((t) => ({
          id: t.id,
          symbol: t.symbol,
          hasProviderMetadata: !!t.providerMetadata,
        })),
      },
      'Starting Google Sheets token filtering'
    );

    const tokenTypesMap = await this.db
      .select({
        tokenId: schema.tokens.id,
        typeCode: schema.tokenTypes.code,
      })
      .from(schema.tokens)
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(
        inArray(
          schema.tokens.id,
          tokensToFilter.map((t) => t.id)
        )
      );

    const typeCodeLookup = new Map<string, string>();
    for (const row of tokenTypesMap) {
      typeCodeLookup.set(row.tokenId, row.typeCode);
    }

    // Google Sheets supports stock type (which covers Stock/ETF/Equity/Commodity)
    const googleSheetsCompatibleTypes = ['stock'];

    const eligibleTokens = tokensToFilter.filter((token) => {
      const typeCode = typeCodeLookup.get(token.id);

      this.logger.debug(
        {
          tokenId: token.id,
          symbol: token.symbol,
          typeCode,
          providerMetadata: token.providerMetadata,
        },
        'Evaluating token for Google Sheets eligibility'
      );

      if (typeCode && googleSheetsCompatibleTypes.includes(typeCode.toLowerCase())) {
        this.logger.info(
          {
            tokenId: token.id,
            symbol: token.symbol,
            typeCode,
          },
          'Including token due to compatible type for Google Sheets'
        );
        return true;
      }

      try {
        const metadata = JSON.parse(token.providerMetadata || '{}');

        this.logger.debug(
          {
            tokenId: token.id,
            symbol: token.symbol,
            metadata,
            hasFinnhub: !!metadata.finnhub,
            finnhubSymbol: metadata.finnhub?.symbol,
          },
          'Checking token provider metadata for Finnhub'
        );

        if (metadata.finnhub?.symbol) {
          this.logger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              finnhubSymbol: metadata.finnhub.symbol,
            },
            'Including token with Finnhub metadata for Google Sheets fallback'
          );
          return true;
        }
      } catch (error) {
        this.logger.warn(
          {
            tokenId: token.id,
            symbol: token.symbol,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to parse provider metadata'
        );
      }

      this.logger.debug(
        {
          tokenId: token.id,
          symbol: token.symbol,
          typeCode,
        },
        'Excluding token from Google Sheets - no compatible type or Finnhub metadata'
      );

      return false;
    });

    this.logger.info(
      {
        totalTokens: tokensToFilter.length,
        eligibleTokens: eligibleTokens.length,
        eligibleSymbols: eligibleTokens.map((t) => t.symbol),
      },
      'Google Sheets token filtering completed'
    );

    return eligibleTokens;
  }

  private initializeCredentials(): boolean {
    const encodedKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    if (!this.spreadsheetId || !encodedKey) {
      this.logger.debug('Google Sheets not configured - fallback provider disabled');
      return false;
    }

    try {
      const decodedKey = Buffer.from(encodedKey, 'base64').toString('utf-8');
      this.googleSheetsCredentials = JSON.parse(decodedKey);
      this.logger.debug('Google Sheets fallback provider initialized successfully');
      return true;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to parse Google Sheets service account key - fallback provider disabled'
      );
      return false;
    }
  }

  private isLivePrice(timestamp: Date): boolean {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    return diffMs < 2 * 60 * 60 * 1000;
  }

  private async withGoogleSheetsLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockAcquired = await this.tryAcquireGoogleSheetsLock();

    if (!lockAcquired) {
      this.logger.warn('Proceeding with Google Sheets operation without lock to prevent deadlock');
      return await fn();
    }

    try {
      return await fn();
    } finally {
      await this.releaseGoogleSheetsLock();
    }
  }

  private async tryAcquireGoogleSheetsLock(timeoutMs: number = 5000): Promise<boolean> {
    const startTime = Date.now();

    this.logger.debug(
      { lockId: this.GOOGLE_SHEETS_LOCK_ID, timeoutMs },
      'Attempting to acquire Google Sheets advisory lock with timeout'
    );

    while (Date.now() - startTime < timeoutMs) {
      try {
        const result = (await this.db.execute(
          `SELECT pg_try_advisory_lock(${this.GOOGLE_SHEETS_LOCK_ID}) as acquired`
        )) as unknown as Array<{ acquired: boolean }>;

        const acquired = result[0]?.acquired;
        if (acquired) {
          this.logger.debug(
            { lockId: this.GOOGLE_SHEETS_LOCK_ID },
            'Google Sheets advisory lock acquired'
          );
          return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        this.logger.warn(
          { error, lockId: this.GOOGLE_SHEETS_LOCK_ID },
          'Failed to acquire Google Sheets advisory lock'
        );
        break;
      }
    }

    this.logger.warn(
      { lockId: this.GOOGLE_SHEETS_LOCK_ID, timeoutMs },
      'Failed to acquire Google Sheets advisory lock within timeout'
    );
    return false;
  }

  private async releaseGoogleSheetsLock(): Promise<void> {
    this.logger.debug(
      { lockId: this.GOOGLE_SHEETS_LOCK_ID },
      'Releasing Google Sheets advisory lock'
    );

    try {
      await this.db.execute(`SELECT pg_advisory_unlock(${this.GOOGLE_SHEETS_LOCK_ID})`);

      this.logger.debug(
        { lockId: this.GOOGLE_SHEETS_LOCK_ID },
        'Google Sheets advisory lock released'
      );
    } catch (error) {
      this.logger.warn(
        { error, lockId: this.GOOGLE_SHEETS_LOCK_ID },
        'Failed to release Google Sheets advisory lock (may have been already released)'
      );
    }
  }

  private async updateTokenGoogleSheetsMetadata(
    tokenId: string,
    rowNumber: number,
    exchangeInfo: CachedExchangeInfo | null = null
  ): Promise<void> {
    try {
      const [token] = await this.db
        .select({ providerMetadata: schema.tokens.providerMetadata })
        .from(schema.tokens)
        .where(eq(schema.tokens.id, tokenId))
        .limit(1);

      if (!token) return;

      let metadata: Record<string, unknown> = {};
      try {
        metadata =
          typeof token.providerMetadata === 'string'
            ? JSON.parse(token.providerMetadata)
            : token.providerMetadata || {};
      } catch (error) {
        this.logger.warn({ tokenId, error }, 'Failed to parse existing token metadata');
      }

      metadata.googleSheets = {
        rowNumber,
        column: 'B',
        addedAt: new Date().toISOString(),
      };

      if (exchangeInfo && !metadata.exchangeInfo) {
        metadata.exchangeInfo = {
          ...exchangeInfo,
          updatedAt: new Date().toISOString(),
        };
      }

      await this.db
        .update(schema.tokens)
        .set({ providerMetadata: JSON.stringify(metadata) })
        .where(eq(schema.tokens.id, tokenId));

      this.logger.debug(
        { tokenId, rowNumber, column: 'B', hasExchangeInfo: !!exchangeInfo },
        'Updated token metadata with Google Sheets row, column and exchange info'
      );
    } catch (error) {
      this.logger.error(
        { tokenId, rowNumber, error },
        'Failed to update token Google Sheets metadata'
      );
    }
  }

  private async getTokenExchangeInfo(token: schema.Token): Promise<CachedExchangeInfo | null> {
    try {
      const metadata = JSON.parse(token.providerMetadata || '{}');
      if (metadata.exchangeInfo) {
        this.logger.debug(
          { tokenId: token.id, symbol: token.symbol },
          'Using cached exchange info from token metadata'
        );
        return metadata.exchangeInfo as CachedExchangeInfo;
      }
    } catch (error) {
      this.logger.debug({ tokenId: token.id, error }, 'Failed to parse token metadata');
    }

    try {
      const profileInfo = await this.fetchSymbolProfileFromFinnhub(token.symbol);

      if (profileInfo?.exchange) {
        const exchangeInfo: CachedExchangeInfo = {
          currency: profileInfo.currency || 'USD',
          exchange: profileInfo.exchange,
          mic: profileInfo.exchange,
        };

        await this.updateTokenExchangeInfo(token.id, exchangeInfo);

        this.logger.debug(
          {
            tokenId: token.id,
            symbol: token.symbol,
            currency: exchangeInfo.currency,
            exchange: exchangeInfo.exchange,
            name: profileInfo.name,
            country: profileInfo.country,
          },
          'Found and cached exchange info for token using profile2'
        );

        return exchangeInfo;
      }

      this.logger.warn(
        { tokenId: token.id, symbol: token.symbol },
        'Symbol not found in Finnhub profile2 or no exchange info available'
      );

      const fallbackExchangeInfo = this.detectExchangeFromSymbol(token.symbol);
      if (fallbackExchangeInfo) {
        await this.updateTokenExchangeInfo(token.id, fallbackExchangeInfo);
        this.logger.debug(
          {
            tokenId: token.id,
            symbol: token.symbol,
            currency: fallbackExchangeInfo.currency,
            exchange: fallbackExchangeInfo.exchange,
            method: 'symbol_pattern_detection',
          },
          'Detected exchange info from symbol pattern'
        );
        return fallbackExchangeInfo;
      }

      return null;
    } catch (error) {
      this.logger.error(
        { error, tokenId: token.id, symbol: token.symbol },
        'Error fetching exchange info from Finnhub'
      );
      return null;
    }
  }

  private async updateTokenExchangeInfo(
    tokenId: string,
    exchangeInfo: CachedExchangeInfo
  ): Promise<void> {
    try {
      const [token] = await this.db
        .select({ providerMetadata: schema.tokens.providerMetadata })
        .from(schema.tokens)
        .where(eq(schema.tokens.id, tokenId))
        .limit(1);

      if (!token) return;

      let metadata: Record<string, unknown> = {};
      try {
        metadata =
          typeof token.providerMetadata === 'string'
            ? JSON.parse(token.providerMetadata)
            : token.providerMetadata || {};
      } catch (error) {
        this.logger.warn({ tokenId, error }, 'Failed to parse existing token metadata');
      }

      metadata.exchangeInfo = {
        ...exchangeInfo,
        updatedAt: new Date().toISOString(),
      };

      await this.db
        .update(schema.tokens)
        .set({ providerMetadata: JSON.stringify(metadata) })
        .where(eq(schema.tokens.id, tokenId));

      this.logger.debug({ tokenId, exchangeInfo }, 'Updated token metadata with exchange info');
    } catch (error) {
      this.logger.error({ tokenId, exchangeInfo, error }, 'Failed to update token exchange info');
    }
  }

  private async fetchSymbolProfileFromFinnhub(symbol: string): Promise<{
    exchange?: string;
    currency?: string;
    name?: string;
    country?: string;
  } | null> {
    try {
      const url = `${config.finnhub.baseUrl}/stock/profile2?symbol=${symbol}&token=${config.finnhub.apiKey}`;
      const response = await this.finnhubRateLimiter.execute(async () => {
        return await fetchWithTimeout(url);
      });

      if (!response.ok) {
        this.logger.debug(
          { symbol, status: response.status },
          'Failed to fetch symbol profile from Finnhub'
        );
        return null;
      }

      const profileData = (await response.json()) as {
        exchange?: string;
        currency?: string;
        name?: string;
        country?: string;
      };

      if (!profileData.name || !profileData.exchange) {
        this.logger.debug({ symbol, profileData }, 'Finnhub profile returned incomplete data');
        return null;
      }

      this.logger.debug(
        {
          symbol,
          exchange: profileData.exchange,
          currency: profileData.currency,
          name: profileData.name,
          country: profileData.country,
        },
        'Successfully fetched symbol profile from Finnhub'
      );

      return profileData;
    } catch (error) {
      this.logger.debug({ error, symbol }, 'Error fetching symbol profile from Finnhub');
      return null;
    }
  }

  private createGoogleFinanceFormula(
    symbol: string,
    exchangeInfo: CachedExchangeInfo | null
  ): string {
    const safeSymbol = sanitizeForGoogleFinanceSymbol(symbol);

    if (!exchangeInfo) {
      return `=GOOGLEFINANCE("${safeSymbol}")`;
    }

    const googlePrefix = this.getGoogleFinancePrefix(exchangeInfo);
    const baseSymbol = sanitizeForGoogleFinanceSymbol(
      this.extractBaseSymbol(safeSymbol, exchangeInfo)
    );

    if (googlePrefix) {
      const prefixedSymbol = `${googlePrefix}:${baseSymbol}`;
      return `=GOOGLEFINANCE("${prefixedSymbol}")`;
    }

    return `=GOOGLEFINANCE("${baseSymbol}")`;
  }

  private extractBaseSymbol(symbol: string, exchangeInfo: CachedExchangeInfo): string {
    if (!symbol.includes('.')) {
      return symbol;
    }

    const exchangeSuffixMap: Record<string, string[]> = {
      TSE: ['.TO', '.TSX'],
      LON: ['.L', '.LSE'],
      FRA: ['.DE', '.F', '.FRA'],
      EPA: ['.PA'],
      AMS: ['.AS'],
      ASX: ['.AX'],
      TYO: ['.T'],
      HKG: ['.HK'],
    };

    const googlePrefix = this.getGoogleFinancePrefix(exchangeInfo);

    if (googlePrefix && exchangeSuffixMap[googlePrefix]) {
      for (const suffix of exchangeSuffixMap[googlePrefix]) {
        if (symbol.toUpperCase().endsWith(suffix)) {
          return symbol.substring(0, symbol.length - suffix.length);
        }
      }
    }

    return symbol.split('.')[0] || symbol;
  }

  private getGoogleFinancePrefix(exchangeInfo: CachedExchangeInfo): string | null {
    const exchange = exchangeInfo.exchange.toUpperCase();

    const exchangeToPrefix: Record<string, string | null> = {
      US: null,
      NASDAQ: null,
      NYSE: null,
      'NEW YORK STOCK EXCHANGE': null,
      'NASDAQ GLOBAL MARKET': null,
      'NASDAQ CAPITAL MARKET': null,
      TO: 'TSE',
      TSX: 'TSE',
      'TORONTO STOCK EXCHANGE': 'TSE',
      'CANADIAN SECURITIES EXCHANGE': 'CSE',
      'TSX VENTURE EXCHANGE': 'CVE',
      L: 'LON',
      LSE: 'LON',
      'LONDON STOCK EXCHANGE': 'LON',
      PA: 'EPA',
      'EURONEXT PARIS': 'EPA',
      PARIS: 'EPA',
      DE: 'FRA',
      FRA: 'FRA',
      FRANKFURT: 'FRA',
      XETRA: 'FRA',
      'FRANKFURT STOCK EXCHANGE': 'FRA',
      AS: 'AMS',
      'EURONEXT AMSTERDAM': 'AMS',
      AMSTERDAM: 'AMS',
      BR: 'EBR',
      'EURONEXT BRUSSELS': 'EBR',
      BRUSSELS: 'EBR',
      MI: 'BIT',
      'BORSA ITALIANA': 'BIT',
      MILAN: 'BIT',
      MC: 'BME',
      MADRID: 'BME',
      'BOLSA DE MADRID': 'BME',
      LS: 'ELI',
      'EURONEXT LISBON': 'ELI',
      LISBON: 'ELI',
      SW: 'SWX',
      'SIX SWISS EXCHANGE': 'SWX',
      SWISS: 'SWX',
      ZURICH: 'SWX',
      ST: 'STO',
      'NASDAQ STOCKHOLM': 'STO',
      STOCKHOLM: 'STO',
      OL: 'OSE',
      'OSLO BORS': 'OSE',
      OSLO: 'OSE',
      CO: 'CSE',
      'NASDAQ COPENHAGEN': 'CSE',
      COPENHAGEN: 'CSE',
      HE: 'HEL',
      'NASDAQ HELSINKI': 'HEL',
      HELSINKI: 'HEL',
      IC: 'ICE',
      'NASDAQ ICELAND': 'ICE',
      ICELAND: 'ICE',
      T: null,
      'TOKYO STOCK EXCHANGE': null,
      TOKYO: null,
      HK: 'HKG',
      'HONG KONG STOCK EXCHANGE': 'HKG',
      'HONG KONG': 'HKG',
      SS: 'SHA',
      'SHANGHAI STOCK EXCHANGE': 'SHA',
      SHANGHAI: 'SHA',
      SZ: 'SHE',
      'SHENZHEN STOCK EXCHANGE': 'SHE',
      SHENZHEN: 'SHE',
      KS: 'KRX',
      'KOREA STOCK EXCHANGE': 'KRX',
      SEOUL: 'KRX',
      AX: 'ASX',
      'AUSTRALIAN STOCK EXCHANGE': 'ASX',
      AUSTRALIA: 'ASX',
      NS: 'NSE',
      'NATIONAL STOCK EXCHANGE OF INDIA': 'NSE',
      BO: 'BSE',
      'BOMBAY STOCK EXCHANGE': 'BSE',
      SI: 'SGX',
      'SINGAPORE STOCK EXCHANGE': 'SGX',
      SINGAPORE: 'SGX',
      TA: 'TLV',
      'TEL AVIV STOCK EXCHANGE': 'TLV',
      'TEL AVIV': 'TLV',
      SA: 'SAU',
      'SAUDI STOCK EXCHANGE': 'SAU',
      TADAWUL: 'SAU',
      JO: 'JSE',
      'JOHANNESBURG STOCK EXCHANGE': 'JSE',
      JOHANNESBURG: 'JSE',
      MX: 'BMV',
      'BOLSA MEXICANA DE VALORES': 'BMV',
      MEXICO: 'BMV',
      BA: 'BCBA',
      'BOLSA DE COMERCIO DE BUENOS AIRES': 'BCBA',
      'BUENOS AIRES': 'BCBA',
    };

    const prefix = exchangeToPrefix[exchange];

    if (prefix !== undefined) {
      return prefix;
    }

    const exchangeLower = exchange.toLowerCase();

    if (exchangeLower.includes('nasdaq')) {
      return null;
    }
    if (exchangeLower.includes('nyse') || exchangeLower.includes('new york')) {
      return null;
    }
    if (exchangeLower.includes('toronto') || exchangeLower.includes('tsx')) {
      return 'TSE';
    }
    if (exchangeLower.includes('london') || exchangeLower.includes('lse')) {
      return 'LON';
    }
    if (exchangeLower.includes('frankfurt') || exchangeLower.includes('xetra')) {
      return 'FRA';
    }
    if (exchangeLower.includes('paris') || exchangeLower.includes('euronext')) {
      return 'EPA';
    }
    if (exchangeLower.includes('amsterdam')) {
      return 'AMS';
    }
    if (exchangeLower.includes('tokyo')) {
      return 'TYO';
    }
    if (exchangeLower.includes('hong kong')) {
      return 'HKG';
    }
    if (exchangeLower.includes('australia') || exchangeLower.includes('asx')) {
      return 'ASX';
    }

    this.logger.debug(
      { exchange: exchangeInfo.exchange },
      'No Google Finance prefix mapping found for exchange'
    );
    return null;
  }

  private detectExchangeFromSymbol(symbol: string): CachedExchangeInfo | null {
    const exchangePatterns: Record<string, { exchange: string; currency: string; mic: string }> = {
      '.AS': { exchange: 'AS', currency: 'EUR', mic: 'XAMS' },
      '.DE': { exchange: 'DE', currency: 'EUR', mic: 'XETR' },
      '.PA': { exchange: 'PA', currency: 'EUR', mic: 'XPAR' },
      '.MI': { exchange: 'MI', currency: 'EUR', mic: 'MTAA' },
      '.MC': { exchange: 'MC', currency: 'EUR', mic: 'XMAD' },
      '.BR': { exchange: 'BR', currency: 'EUR', mic: 'XBRU' },
      '.LS': { exchange: 'LS', currency: 'EUR', mic: 'XLIS' },
      '.SW': { exchange: 'SW', currency: 'CHF', mic: 'XSWX' },
      '.L': { exchange: 'L', currency: 'GBP', mic: 'XLON' },
      '.ST': { exchange: 'ST', currency: 'SEK', mic: 'XSTO' },
      '.OL': { exchange: 'OL', currency: 'NOK', mic: 'XOSL' },
      '.CO': { exchange: 'CO', currency: 'DKK', mic: 'XCSE' },
      '.HE': { exchange: 'HE', currency: 'EUR', mic: 'XHEL' },
      '.IC': { exchange: 'IC', currency: 'ISK', mic: 'XICE' },
      '.TO': { exchange: 'TO', currency: 'CAD', mic: 'XTSE' },
      '.V': { exchange: 'V', currency: 'CAD', mic: 'XTSX' },
      '.T': { exchange: 'T', currency: 'JPY', mic: 'XJPX' },
      '.HK': { exchange: 'HK', currency: 'HKD', mic: 'XHKG' },
      '.SS': { exchange: 'SS', currency: 'CNY', mic: 'XSHG' },
      '.SZ': { exchange: 'SZ', currency: 'CNY', mic: 'XSHE' },
      '.KS': { exchange: 'KS', currency: 'KRW', mic: 'XKRX' },
      '.TW': { exchange: 'TW', currency: 'TWD', mic: 'XTAI' },
      '.SI': { exchange: 'SI', currency: 'SGD', mic: 'XSES' },
      '.AX': { exchange: 'AX', currency: 'AUD', mic: 'XASX' },
      '.NZ': { exchange: 'NZ', currency: 'NZD', mic: 'XNZE' },
      '.SA': { exchange: 'SA', currency: 'BRL', mic: 'BVMF' },
      '.MX': { exchange: 'MX', currency: 'MXN', mic: 'XMEX' },
      '.JO': { exchange: 'JO', currency: 'ZAR', mic: 'XJSE' },
      '.BO': { exchange: 'BO', currency: 'INR', mic: 'XBOM' },
      '.NS': { exchange: 'NS', currency: 'INR', mic: 'XNSE' },
    };

    for (const [suffix, info] of Object.entries(exchangePatterns)) {
      if (symbol.toUpperCase().endsWith(suffix.toUpperCase())) {
        return {
          exchange: info.exchange,
          currency: info.currency,
          mic: info.mic,
        };
      }
    }

    const japanesePattern = /^\d+\.T$/i;
    if (japanesePattern.test(symbol)) {
      return {
        exchange: 'T',
        currency: 'JPY',
        mic: 'XJPX',
      };
    }

    if (!symbol.includes('.') && !/[^A-Z0-9]/i.test(symbol)) {
      return {
        exchange: 'US',
        currency: 'USD',
        mic: 'XNAS',
      };
    }

    return null;
  }
}
