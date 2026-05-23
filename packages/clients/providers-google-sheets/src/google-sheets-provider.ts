/**
 * `GoogleSheetsProvider` — fallback / manual-override pricing via the
 * user's Google Sheet wired to GOOGLEFINANCE() formulas. Backend-only:
 * reads per-user sheet config from the DB, so it can't run inside
 * data-provider (which is multi-tenant by design).
 *
 * F3 (2026-04-28): moved out of `@scani/providers/providers/google-sheets/`
 * into its own workspace `@scani/providers-google-sheets`. The
 * `googleapis` SDK (~160MB on disk) used to live as a top-level dep on
 * `@scani/providers`, dragging through `@scani/domain` into every
 * consumer (api, worker, data-provider). The split puts the dep on
 * exactly one workspace; api + worker still need the SDK because their
 * boot wiring constructs and registers the provider, but the dep edge
 * is now explicit per app.
 *
 * Implements `CurrentPriceProvider` so it slots into `ProviderRegistry`
 * the same way every other pricer does. PricingService obtains it via
 * `registry.getAllCurrentPricers().find(p => p.providerKey === 'google-sheets')`
 * — no more direct `new GoogleSheetsProvider(...)` in domain code.
 */

import { type DbType, client as pgClient } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import type { CustomLogger } from '@scani/logging';
import type { Capability, CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { loadProvidersConfig } from '@scani/providers/core/config';
import type { PriceQuote, ProviderContext } from '@scani/providers/core/types';
import {
  isValidPrice,
  parseInternationalNumber,
  sanitizeForGoogleFinanceSymbol,
} from '@scani/providers/core/utils/exchange-suffix';
import { fetchWithTimeout } from '@scani/providers/core/utils/fetch';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { eq, inArray } from 'drizzle-orm';
import { google } from 'googleapis';

/**
 * Drizzle's jsonb column returns the parsed value (object) for tokens
 * created via the normal repository path. Some legacy code paths in this
 * file used to write `JSON.stringify(metadata)` into the same column,
 * which Postgres then stored as a JSON-encoded string — so reads can
 * receive either form. This helper normalises both.
 */
interface ParsedTokenMetadata {
  exchangeInfo?: CachedExchangeInfo;
  googleSheets?: { rowNumber?: number; column?: string; addedAt?: string };
  finnhub?: { symbol?: string; name?: string; type?: string };
  provider?: string;
  validatedAt?: string;
  [key: string]: unknown;
}
function parseTokenMetadata(value: unknown): ParsedTokenMetadata {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ParsedTokenMetadata;
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value as ParsedTokenMetadata;
  return {};
}

/** Re-declared here to avoid pulling in `@scani/pricing-providers`. */
export interface PricingResult {
  tokenId: string;
  price: string;
  timestamp: Date;
  source: string;
}

/** Re-declared here to avoid pulling in `@scani/pricing-providers`.
 *  `provider` is intentionally a free-form string — PricingService
 *  routes tokens here only when its discriminator decided GoogleSheets
 *  is the right provider, but the upstream batch can carry tokens
 *  tagged with any `PricingProviderKey`. We don't introspect this
 *  field beyond logging. */
export interface RoutedToken {
  token: schema.Token;
  provider: string;
  providerTokenId?: string;
}

/** Re-declared here to avoid pulling in `@scani/pricing-providers`. */
export interface PricingExecutionContext {
  baseCurrency: schema.Token;
  timestamp: Date;
}

/** Re-declared here to avoid pulling in `@scani/pricing-providers`. */
export type ConvertPriceFn = (
  price: string,
  fromCurrency: string,
  toCurrency: string,
  timestamp: Date
) => Promise<string>;

/** Re-declared here to avoid pulling in `@scani/pricing-providers`. */
export type CreateFailureResultFn = (
  tokenId: string,
  timestamp: Date,
  providerName: string,
  error: unknown,
  options?: { response?: Response; dataEmpty?: boolean }
) => PricingResult;

/** Constants previously sourced from `@scani/pricing-providers`. */
const PROVIDER_NAME_GOOGLE_SHEETS = 'Google Sheets (GOOGLEFINANCE)';
const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

type SheetsLogger = Pick<CustomLogger, 'debug' | 'info' | 'warn' | 'error'>;
type RateLimiter = OutflowRateLimiter;

interface CachedExchangeInfo {
  currency: string;
  exchange: string;
  mic: string;
  updatedAt?: string;
}

interface GoogleSheetsProviderDependencies {
  db: DbType;
  rateLimiter: RateLimiter;
  finnhubRateLimiter: RateLimiter;
  convertPrice: ConvertPriceFn;
  createFailureResult: CreateFailureResultFn;
  logger: SheetsLogger;
}

export class GoogleSheetsProvider implements CurrentPriceProvider {
  // CurrentPriceProvider contract surface.
  readonly providerKey = 'google-sheets';
  readonly capabilities: readonly Capability[] = ['current-price'];

  // Provider key used by metrics dashboards. Distinct from
  // `providerKey` (the registry handle) because the metrics namespace
  // existed before the registry; consolidate when nothing outside the
  // registry reads `key`.
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
    this.spreadsheetId = loadProvidersConfig().GOOGLE_SHEETS_ID || null;
    this.available = this.initializeCredentials();
  }

  isAvailable(): boolean {
    return this.available;
  }

  // ============================================================
  // CurrentPriceProvider — single + batch token pricing wired to the
  // registry. Internally delegates to `fetchPrices` so the heavy
  // GOOGLEFINANCE row-management logic stays in one place.
  // ============================================================

  canPrice(t: schema.Token): boolean {
    if (!this.available) return false;
    // We trust the upstream router (PricingService.groupTokensByProvider)
    // to only send us tokens it deems Google-Sheets-appropriate, but
    // the `canPrice` gate is required by `CurrentPriceProvider`. The
    // `available` check filters out the case where Google Sheets isn't
    // configured at all; per-token gating happens at PricingService.
    return Boolean(t.symbol);
  }

  async fetchCurrentPrice(t: schema.Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    const map = await this.fetchCurrentPrices([t], ctx);
    return map.get(t.id) ?? null;
  }

  async fetchCurrentPrices(
    tokens: schema.Token[],
    ctx: ProviderContext
  ): Promise<Map<string, PriceQuote>> {
    if (tokens.length === 0) return new Map();
    const results = await this.fetchPrices(
      tokens.map((token) => ({ token, provider: 'googleSheets' })),
      { baseCurrency: ctx.baseCurrency, timestamp: ctx.timestamp ?? new Date() }
    );
    const out = new Map<string, PriceQuote>();
    const baseTokenId = ctx.baseCurrency.id;
    for (const r of results) {
      // Drop failure-source rows so callers see an absent entry rather
      // than a fake "0" quote.
      if (r.source.includes('_failure') || r.source.includes('_no_data')) continue;
      out.set(r.tokenId, {
        tokenId: r.tokenId,
        baseTokenId,
        price: r.price,
        timestamp: r.timestamp,
        source: r.source,
      });
    }
    return out;
  }

  async fetchPrices(
    tokensWithMetadata: RoutedToken[],
    { baseCurrency, timestamp }: PricingExecutionContext
  ): Promise<PricingResult[]> {
    if (!this.available || !this.googleSheetsCredentials || !this.spreadsheetId) {
      return [];
    }

    if (!this.isLivePrice(timestamp)) {
      this.logger.debug('Google Sheets only supports live prices, timestamp too old');
      return [];
    }

    const baseCurrencySymbol = baseCurrency.symbol;
    const results: PricingResult[] = [];

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

          const metadata = parseTokenMetadata(freshToken?.providerMetadata);
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
                const metadata = parseTokenMetadata(token.providerMetadata);
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
                source: PROVIDER_NAME_GOOGLE_SHEETS,
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
                  PROVIDER_NAME_GOOGLE_SHEETS,
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
                    const metadata = parseTokenMetadata(token.providerMetadata);
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
                    source: PROVIDER_NAME_GOOGLE_SHEETS,
                  };
                }

                return this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_NAME_GOOGLE_SHEETS,
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
                  PROVIDER_NAME_GOOGLE_SHEETS,
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
                source: PROVIDER_NAME_GOOGLE_SHEETS,
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
                  PROVIDER_NAME_GOOGLE_SHEETS,
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
                  source: PROVIDER_NAME_GOOGLE_SHEETS,
                };
              }

              return this.createFailureResult(
                token.id,
                timestamp,
                PROVIDER_NAME_GOOGLE_SHEETS,
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
                PROVIDER_NAME_GOOGLE_SHEETS,
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
            this.createFailureResult(token.id, timestamp, PROVIDER_NAME_GOOGLE_SHEETS, error, {
              dataEmpty: false,
            })
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
        const metadata = parseTokenMetadata(token.providerMetadata);

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
    const encodedKey = loadProvidersConfig().GOOGLE_SERVICE_ACCOUNT_KEY;

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

  /**
   * Serialise the row-assignment + sheet-write critical section across
   * concurrent batches via a Postgres session-level advisory lock.
   *
   * Pinning matters: `pg_advisory_lock` is **per-connection**, not
   * per-database. The previous implementation called the lock through
   * `db.execute(...)` which pulls a connection from the postgres-js
   * pool, runs the query, and returns the connection — leaving the lock
   * held against a connection nobody references and making every
   * subsequent `pg_try_advisory_lock` call (on a *different* pooled
   * connection) succeed. Two parallel batches therefore both read
   * `currentSheetRows=N` and both wrote to row `N+1`, overwriting each
   * other's GOOGLEFINANCE formulas — surfaced as `priceValue=#N/A`.
   *
   * The fix is `client.reserve()` from postgres-js: it pins one
   * connection for the duration of acquire → critical section → unlock.
   * Same pattern that `PostgresJobLock` (`@scani/jobs`) uses for cron
   * mutual exclusion.
   *
   * Falls through to running `fn` without a lock when acquisition times
   * out — preserving the prior "make progress under contention" stance.
   */
  private async withGoogleSheetsLock<T>(fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
    this.logger.debug(
      { lockId: this.GOOGLE_SHEETS_LOCK_ID, timeoutMs },
      'Attempting to acquire Google Sheets advisory lock with timeout'
    );

    const reserved = await pgClient.reserve();
    let acquired = false;
    try {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        try {
          const rows = (await reserved.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
            String(this.GOOGLE_SHEETS_LOCK_ID),
          ])) as Array<{ locked: boolean }>;
          if (rows[0]?.locked === true) {
            acquired = true;
            this.logger.debug(
              { lockId: this.GOOGLE_SHEETS_LOCK_ID },
              'Google Sheets advisory lock acquired'
            );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          this.logger.warn(
            { error, lockId: this.GOOGLE_SHEETS_LOCK_ID },
            'Failed to acquire Google Sheets advisory lock — continuing unlocked'
          );
          break;
        }
      }

      if (!acquired) {
        this.logger.warn(
          { lockId: this.GOOGLE_SHEETS_LOCK_ID, timeoutMs },
          'Proceeding with Google Sheets operation without lock to prevent deadlock'
        );
      }

      return await fn();
    } finally {
      if (acquired) {
        try {
          await reserved.unsafe('SELECT pg_advisory_unlock($1::bigint)', [
            String(this.GOOGLE_SHEETS_LOCK_ID),
          ]);
          this.logger.debug(
            { lockId: this.GOOGLE_SHEETS_LOCK_ID },
            'Google Sheets advisory lock released'
          );
        } catch (error) {
          this.logger.warn(
            { error, lockId: this.GOOGLE_SHEETS_LOCK_ID },
            'Failed to release Google Sheets advisory lock (auto-releases on connection return)'
          );
        }
      }
      reserved.release();
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

      let metadata: ParsedTokenMetadata = {};
      try {
        metadata = parseTokenMetadata(token.providerMetadata);
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
        .set({ providerMetadata: metadata as unknown as schema.Token['providerMetadata'] })
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
      const metadata = parseTokenMetadata(token.providerMetadata);
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

      let metadata: ParsedTokenMetadata = {};
      try {
        metadata = parseTokenMetadata(token.providerMetadata);
      } catch (error) {
        this.logger.warn({ tokenId, error }, 'Failed to parse existing token metadata');
      }

      metadata.exchangeInfo = {
        ...exchangeInfo,
        updatedAt: new Date().toISOString(),
      };

      await this.db
        .update(schema.tokens)
        .set({ providerMetadata: metadata as unknown as schema.Token['providerMetadata'] })
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
      const finnhubKey = loadProvidersConfig().FINNHUB_API_KEY ?? '';
      const url = `${FINNHUB_BASE_URL}/stock/profile2?symbol=${symbol}&token=${finnhubKey}`;
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
      TSE: ['.TO', '.TSX', '.NE', '.NEO'],
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
      // Cboe Canada (formerly NEO Exchange) has no dedicated GOOGLEFINANCE
      // prefix — Google Finance simply doesn't carry that venue. Most NEO-
      // listed ETFs (XEQT, XUU, XGRO, XBAL, …) are dual-listed on TSX, so
      // we route through `TSE:` and price the TSX line. CDRs (TSLA.TO etc.)
      // trade only on Cboe Canada and remain unpriceable here — that's a
      // known gap pending an alternative upstream.
      NE: 'TSE',
      NEO: 'TSE',
      'NEO EXCHANGE': 'TSE',
      'CBOE CANADA': 'TSE',
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

      // IBKR exchange codes (standard exchange identifiers used by Interactive Brokers)
      TSE: 'TSE',
      SEHK: 'HKG',
      TSEJ: 'TYO',
      SBF: 'EPA',
      FWB: 'FRA',
      IBIS: 'FRA',
      AEB: 'AMS',
      BVME: 'BIT',
      VIRTX: 'SWX',
      EBS: 'SWX',
      BM: 'BME',
      VENTURE: 'CVE',
      CVE: 'CVE',
      'ENEXT.BE': 'EBR',
      BVL: 'ELI',
      HSE: 'HEL',
      KSE: 'CSE',
      OSE: 'OSE',
      SFB: 'STO',
      SGX: 'SGX',
      ASX: 'ASX',
      NSE: 'NSE',
      BSE: 'BSE',
      MEXI: 'BMV',
      BVMF: 'BVMF',
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

    // Don't assume US for plain symbols — this can produce wrong formulas
    // for non-US stocks imported without exchange suffixes (e.g., IBKR's "XEQT").
    // Exchange info should come from token metadata instead.
    return null;
  }
}
