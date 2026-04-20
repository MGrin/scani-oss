/**
 * IbkrFlexQueryService
 *
 * Handles IBKR Flex Query API communications:
 * - Two-step report request/fetch process
 * - XML response parsing for positions and cash balances
 * - Credential validation
 *
 * Flex Query API docs: https://www.interactivebrokers.com/en/software/am/am/reports/flex_web_service_version_3.htm
 */

import { fetchWithTimeout } from '@scani/pricing-providers';
import { credentialBucketKey } from '@scani/rate-limiter';

import type { RateLimiter } from '../types';

const FLEX_BASE_URL =
  'https://ndcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService';

/** Maximum number of retries when the report is still generating */
const MAX_POLL_RETRIES = 5;

/** Delay between poll retries in milliseconds */
const POLL_DELAY_MS = 2000;

/**
 * Parsed open position from IBKR Flex Query XML
 */
export interface IbkrOpenPosition {
  symbol: string;
  description: string;
  position: string;
  markPrice: string;
  positionValue: string;
  currency: string;
  assetCategory: string;
  listingExchange: string;
}

/**
 * Parsed cash balance from IBKR Flex Query XML
 */
export interface IbkrCashBalance {
  currency: string;
  endingCash: string;
}

/**
 * Parsed Flex Query report data
 */
export interface IbkrFlexQueryData {
  positions: IbkrOpenPosition[];
  cashBalances: IbkrCashBalance[];
}

/**
 * IBKR Flex Query API Service
 */
export class IbkrFlexQueryService {
  private readonly rateLimiter?: RateLimiter;

  constructor(rateLimiter?: RateLimiter) {
    this.rateLimiter = rateLimiter;
  }

  /**
   * Request a Flex Query report (Step 1)
   * Returns a reference code to fetch the report, or throws on error.
   */
  async requestReport(token: string, queryId: string): Promise<string> {
    const body = new URLSearchParams({ t: token, q: queryId, v: '3' });

    // IBKR's per-token rate limit (error 1018) is enforced server-side
    // per Flex token — partition our bucket by token so one user can't
    // starve another's IBKR traffic.
    const subKey = credentialBucketKey(token);
    const response = await this.executeWithRateLimit(
      () =>
        fetchWithTimeout(
          `${FLEX_BASE_URL}.SendRequest`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          },
          15000, // 15s timeout - IBKR can be slow
          0 // No automatic retries - we handle polling ourselves
        ),
      subKey
    );

    if (!response.ok) {
      throw new Error(`IBKR SendRequest failed with HTTP ${response.status}`);
    }

    const xml = await response.text();

    // Check for error in response
    const errorMatch = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
    if (errorMatch) {
      const errorMsgMatch = xml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/);
      const errorMsg = errorMsgMatch?.[1] ?? 'Unknown error';
      throw new Error(`IBKR Flex Query error (code ${errorMatch[1]}): ${errorMsg}`);
    }

    // Extract reference code
    const refMatch = xml.match(/<ReferenceCode>([^<]+)<\/ReferenceCode>/);
    if (!refMatch?.[1]) {
      throw new Error('IBKR SendRequest response missing ReferenceCode');
    }

    return refMatch[1];
  }

  /**
   * Fetch a Flex Query report (Step 2)
   * Polls with retries since the report may still be generating.
   * Returns the raw XML response body on success.
   */
  async fetchReport(token: string, referenceCode: string): Promise<string> {
    const body = new URLSearchParams({ t: token, q: referenceCode, v: '3' });
    const subKey = credentialBucketKey(token);

    for (let attempt = 0; attempt < MAX_POLL_RETRIES; attempt++) {
      const response = await this.executeWithRateLimit(
        () =>
          fetchWithTimeout(
            `${FLEX_BASE_URL}.GetStatement`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            },
            30000, // 30s timeout - reports can be large
            0
          ),
        subKey
      );

      if (!response.ok) {
        throw new Error(`IBKR GetStatement failed with HTTP ${response.status}`);
      }

      const xml = await response.text();

      // Check if the report is still generating (ErrorCode 1019)
      const errorMatch = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
      if (errorMatch) {
        const errorCode = errorMatch[1];

        // 1019 = "Statement is being generated, please try again shortly"
        if (errorCode === '1019' && attempt < MAX_POLL_RETRIES - 1) {
          await this.delay(POLL_DELAY_MS);
          continue;
        }

        const errorMsgMatch = xml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/);
        const errorMsg = errorMsgMatch?.[1] ?? 'Unknown error';
        throw new Error(`IBKR Flex Query error (code ${errorCode}): ${errorMsg}`);
      }

      return xml;
    }

    throw new Error(`IBKR report still generating after ${MAX_POLL_RETRIES} retries`);
  }

  /**
   * Execute the full two-step Flex Query process and return parsed data
   */
  async getFlexQueryData(token: string, queryId: string): Promise<IbkrFlexQueryData> {
    const referenceCode = await this.requestReport(token, queryId);
    // Brief pause before first poll to give IBKR time to generate
    await this.delay(POLL_DELAY_MS);
    const xml = await this.fetchReport(token, referenceCode);
    return this.parseFlexQueryXml(xml);
  }

  /**
   * Validate credentials by attempting Step 1 of the Flex Query process.
   * If the SendRequest succeeds and returns a reference code, credentials are valid.
   */
  async validateCredentials(token: string, queryId: string): Promise<boolean> {
    // Let errors bubble up with their real message (e.g. IBKR's
    // "Invalid request or unable to validate request" vs. a network
    // timeout). The router factory wraps thrown messages into the UI
    // error; a generic "return false" hides the cause and leaves the
    // user with no path forward.
    await this.requestReport(token, queryId);
    return true;
  }

  /**
   * Parse Flex Query XML response into structured data.
   * Uses regex-based parsing for the well-structured IBKR XML format.
   */
  parseFlexQueryXml(xml: string): IbkrFlexQueryData {
    const positions = this.parseOpenPositions(xml);
    const cashBalances = this.parseCashReport(xml);

    return { positions, cashBalances };
  }

  /**
   * Parse OpenPosition elements from XML
   */
  private parseOpenPositions(xml: string): IbkrOpenPosition[] {
    const positions: IbkrOpenPosition[] = [];
    const positionRegex = /<OpenPosition\s+([^>]*)\/?>/g;

    for (const match of xml.matchAll(positionRegex)) {
      const attrs = match[1] ?? '';
      const position: IbkrOpenPosition = {
        symbol: this.extractAttr(attrs, 'symbol'),
        description: this.extractAttr(attrs, 'description'),
        position: this.extractAttr(attrs, 'position'),
        markPrice: this.extractAttr(attrs, 'markPrice'),
        positionValue: this.extractAttr(attrs, 'positionValue'),
        currency: this.extractAttr(attrs, 'currency'),
        assetCategory: this.extractAttr(attrs, 'assetCategory'),
        listingExchange: this.extractAttr(attrs, 'listingExchange'),
      };

      // Only include positions with non-zero quantity
      const qty = parseFloat(position.position);
      if (!Number.isNaN(qty) && qty !== 0) {
        positions.push(position);
      }
    }

    return positions;
  }

  /**
   * Parse CashReportCurrency elements from XML
   */
  private parseCashReport(xml: string): IbkrCashBalance[] {
    const balances: IbkrCashBalance[] = [];
    const cashRegex = /<CashReportCurrency\s+([^>]*)\/?>/g;

    for (const match of xml.matchAll(cashRegex)) {
      const attrs = match[1] ?? '';
      const currency = this.extractAttr(attrs, 'currency');

      // Skip aggregate summary rows
      if (currency === 'BASE_SUMMARY') continue;

      // Try endingCash first, fall back to endingSettledCash
      let endingCash = this.extractAttr(attrs, 'endingCash');
      if (!endingCash) {
        endingCash = this.extractAttr(attrs, 'endingSettledCash');
      }

      const balance: IbkrCashBalance = {
        currency,
        endingCash,
      };

      // Only include non-zero cash balances
      const cash = parseFloat(balance.endingCash);
      if (!Number.isNaN(cash) && cash !== 0) {
        balances.push(balance);
      }
    }

    return balances;
  }

  /**
   * Extract an attribute value from an XML attribute string
   */
  private extractAttr(attrs: string, name: string): string {
    const regex = new RegExp(`${name}="([^"]*)"`, 'i');
    const match = attrs.match(regex);
    return match?.[1] ?? '';
  }

  /**
   * Execute function with rate limiting if configured. `subKey`
   * partitions the provider-wide bucket by credential hash.
   */
  private async executeWithRateLimit<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn, subKey);
    }
    return fn();
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
