/**
 * PlaidIntegration - Integration for Plaid bank connections
 *
 * Handles fetching accounts and balances from Plaid-connected institutions
 * Focus: Accounts and balances only (no transactions per requirements)
 */

import { ScaniIntegration } from '../base';
import type { PlaidApiService } from '../services/PlaidApiService';
import type {
  AuthConfig,
  FetchAccountsResult,
  FetchHoldingsResult,
  ICredentialManager,
  IntegrationHolding,
  IWalletManager,
  RateLimiter,
  TokenMappingResult,
} from '../types';

export class PlaidIntegration extends ScaniIntegration {
  private readonly plaidService: PlaidApiService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    plaidService: PlaidApiService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.plaidService = plaidService;
  }

  /**
   * Fetch accounts from Plaid
   * Returns all accounts associated with the access token
   */
  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      if (!credentials?.accessToken) {
        return {
          accounts: [],
          total: 0,
          errors: ['No Plaid access token provided'],
        };
      }

      const accessToken = credentials.accessToken as string;

      // Get accounts from Plaid
      const response = await this.plaidService.getAccounts({
        access_token: accessToken,
      });

      // Map Plaid accounts to Scani format
      const accounts = response.accounts.map((account) => ({
        externalId: account.account_id,
        name: account.official_name || account.name,
        accountType: this.mapAccountType(account.type, account.subtype),
        description: `${account.type} - ${account.subtype || 'standard'}`,
        metadata: {
          plaidAccountId: account.account_id,
          plaidItemId: response.item.item_id,
          mask: account.mask,
          officialName: account.official_name,
          type: account.type,
          subtype: account.subtype,
        },
        isActive: true,
      }));

      return {
        accounts,
        total: accounts.length,
      };
    } catch (error) {
      return {
        accounts: [],
        total: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error fetching accounts'],
      };
    }
  }

  /**
   * Fetch holdings (balances) for a specific account
   * For Plaid, we return the account balance as a holding of the currency
   */
  async fetchHoldings(
    accountId: string,
    credentials?: Record<string, unknown>
  ): Promise<FetchHoldingsResult> {
    try {
      if (!credentials?.accessToken) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['No Plaid access token provided'],
        };
      }

      const accessToken = credentials.accessToken as string;

      // Get balances for the specific account
      const response = await this.plaidService.getBalances(accessToken, [accountId]);

      // Find the account
      const account = response.accounts.find((acc) => acc.account_id === accountId);

      if (!account) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: ['Account not found'],
        };
      }

      // Create a holding for the account balance
      // Use current balance (includes pending transactions)
      const balance = account.balances.current || account.balances.available || 0;
      const currency =
        account.balances.iso_currency_code || account.balances.unofficial_currency_code || 'USD';

      const holdings: IntegrationHolding[] = [];

      // Only add holding if balance is non-zero or account is active
      if (balance !== 0 || balance === 0) {
        // Determine token type based on account type
        // - depository, credit, loan accounts hold fiat currencies
        // - investment accounts may hold stocks, ETFs, or other securities
        // Let the token type be determined by the integration, not hardcoded here
        let tokenType: string | undefined;
        const decimals = 2; // Default for fiat currencies

        if (account.type === 'depository' || account.type === 'credit' || account.type === 'loan') {
          // Bank accounts, credit cards, loans are always in fiat currency
          tokenType = 'fiat';
          // decimals already set to 2 above
        }
        // For investment accounts, don't set tokenType - let it be determined
        // by the currency code or external data
        // Investment accounts can hold stocks (AAPL, TSLA), ETFs, bonds, etc.
        // Leave tokenType undefined and decimals at default

        // Always add, even if zero, so we can track the account
        holdings.push({
          symbol: currency,
          name: currency,
          balance: Math.abs(balance).toString(),
          decimals,
          tokenType, // Will be 'fiat' for bank accounts, undefined for investment accounts
          metadata: {
            accountType: account.type,
            accountSubtype: account.subtype,
            mask: account.mask,
            availableBalance: account.balances.available,
            currentBalance: account.balances.current,
            limit: account.balances.limit,
            isNegative: balance < 0, // Track if this is a liability (credit card, loan)
          },
        });
      }

      return {
        holdings,
        total: holdings.length,
        accountId,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        holdings: [],
        total: 0,
        accountId,
        timestamp: new Date(),
        errors: [error instanceof Error ? error.message : 'Unknown error fetching holdings'],
      };
    }
  }

  /**
   * Map a Plaid holding to a Scani token
   * Token type is determined by account type:
   * - Bank accounts (depository/credit/loan) hold fiat currencies
   * - Investment accounts may hold stocks, ETFs, or other securities
   */
  async mapToken(holding: IntegrationHolding): Promise<TokenMappingResult> {
    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: '', // Will be set by the token service based on token type
        decimals: holding.decimals ?? 2, // Use holding decimals, fallback to 2 if null/undefined
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          provider: 'plaid',
          tokenType: holding.tokenType, // Token type from holding (may be undefined for investment accounts)
          ...holding.metadata,
        }),
      },
      isNew: false,
      confidence: 1.0,
    };
  }

  /**
   * Map Plaid account types to Scani account types
   */
  private mapAccountType(type: string, subtype: string | null): string {
    // Plaid account type mappings
    const mapping: Record<string, string> = {
      'depository:checking': 'checking',
      'depository:savings': 'savings',
      'depository:hsa': 'savings',
      'depository:cd': 'savings',
      'depository:money market': 'savings',
      'depository:paypal': 'checking',
      'depository:prepaid': 'checking',
      'depository:cash management': 'checking',
      'depository:ebt': 'checking',
      'credit:credit card': 'credit',
      'credit:paypal': 'credit',
      'loan:auto': 'loan',
      'loan:commercial': 'loan',
      'loan:construction': 'loan',
      'loan:consumer': 'loan',
      'loan:home equity': 'loan',
      'loan:line of credit': 'loan',
      'loan:loan': 'loan',
      'loan:mortgage': 'loan',
      'loan:overdraft': 'loan',
      'loan:student': 'loan',
      'investment:401k': 'investment',
      'investment:403b': 'investment',
      'investment:529': 'investment',
      'investment:brokerage': 'investment',
      'investment:cash isa': 'investment',
      'investment:education savings account': 'investment',
      'investment:fixed annuity': 'investment',
      'investment:gic': 'investment',
      'investment:health reimbursement arrangement': 'investment',
      'investment:hsa': 'investment',
      'investment:ira': 'investment',
      'investment:isa': 'investment',
      'investment:keogh': 'investment',
      'investment:lif': 'investment',
      'investment:lira': 'investment',
      'investment:lrif': 'investment',
      'investment:lrsp': 'investment',
      'investment:mutual fund': 'investment',
      'investment:non-taxable brokerage account': 'investment',
      'investment:pension': 'investment',
      'investment:plan': 'investment',
      'investment:prif': 'investment',
      'investment:profit sharing plan': 'investment',
      'investment:rdsp': 'investment',
      'investment:resp': 'investment',
      'investment:retirement': 'investment',
      'investment:rlif': 'investment',
      'investment:roth': 'investment',
      'investment:roth 401k': 'investment',
      'investment:rrif': 'investment',
      'investment:rrsp': 'investment',
      'investment:sarsep': 'investment',
      'investment:sep ira': 'investment',
      'investment:simple ira': 'investment',
      'investment:sipp': 'investment',
      'investment:stock plan': 'investment',
      'investment:tfsa': 'investment',
      'investment:trust': 'investment',
      'investment:ugma': 'investment',
      'investment:utma': 'investment',
      'investment:variable annuity': 'investment',
    };

    const key = subtype ? `${type}:${subtype}` : type;
    return mapping[key] || type || 'other';
  }

  /**
   * Validate Plaid access token
   */
  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    try {
      if (!credentials?.accessToken) {
        return false;
      }

      const accessToken = credentials.accessToken as string;

      // Try to get item to validate token
      await this.plaidService.getItem({
        access_token: accessToken,
      });

      return true;
    } catch {
      return false;
    }
  }
}
