import type { CreateInstitutionInput } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { Institution } from '../domain/entities';
import { AccountRepository } from '../repositories/AccountRepository';
import type { DatabaseTransaction } from '../repositories/BaseRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { InstitutionRepository } from '../repositories/InstitutionRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { BaseService } from './BaseService';
import { PortfolioValuationService } from './PortfolioValuationService';

@Service()
export class InstitutionService extends BaseService {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly portfolioService = Container.get(PortfolioValuationService);

  constructor() {
    super('InstitutionService');
  }

  async createInstitution(
    data: CreateInstitutionInput,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Institution> {
    try {
      this.logInfo('Creating institution', { name: data.name, userId });

      this.validateRequiredFields(data, ['name', 'typeId']);
      this.validateNonEmptyString(data.name, 'name');

      const institution = await this.institutionRepository.create(
        {
          name: data.name,
          typeId: data.typeId,
          description: data.description || null,
          website: data.website || null,
          logoUrl: data.logoUrl || null,
          isActive: true,
        },
        tx
      );

      this.logInfo('Institution created', { institutionId: institution.id });
      return institution;
    } catch (error) {
      throw this.handleError(error, 'createInstitution');
    }
  }

  /**
   * Get institutions by user ID with summary information (account count and total value)
   */
  async getInstitutionsByUserIdWithSummary(userId: string): Promise<
    Array<
      Institution & {
        summary: {
          accountCount: number;
          totalValue: string;
        };
      }
    >
  > {
    try {
      this.logInfo('Getting institutions with summary', { userId });

      // Get user's institutions
      const institutions = await this.institutionRepository.findByUserId(userId);

      if (institutions.length === 0) {
        return [];
      }

      // Get all related data
      const accounts = await this.accountRepository.findByUser(userId);
      const holdings = await this.holdingRepository.findByUser(userId);
      // Filter out inactive holdings from calculations
      const activeHoldings = holdings.filter((h) => h.isActive);
      const portfolioValue = await this.portfolioService.getUserPortfolioValue(userId);

      // Create maps for efficient lookups
      const holdingsByAccount = new Map<string, typeof activeHoldings>();
      for (const holding of activeHoldings) {
        if (!holdingsByAccount.has(holding.accountId)) {
          holdingsByAccount.set(holding.accountId, []);
        }
        holdingsByAccount.get(holding.accountId)!.push(holding);
      }

      const accountsByInstitution = new Map<string, typeof accounts>();
      for (const account of accounts) {
        if (!accountsByInstitution.has(account.institutionId)) {
          accountsByInstitution.set(account.institutionId, []);
        }
        accountsByInstitution.get(account.institutionId)!.push(account);
      }

      // Get token repository to map holding tokenIds to symbols and prices
      const tokenIds = [...new Set(activeHoldings.map((h) => h.tokenId))];
      const tokens = await this.tokenRepository.findByIds(tokenIds);
      const tokenMap = new Map(tokens.map((t) => [t.id, t]));

      // Create a map of token prices from the portfolio value holdings
      // Use the price (calculated as value/balance) for each token
      const tokenPriceMap = new Map<string, string>();
      for (const portfolioHolding of portfolioValue.holdings) {
        try {
          const balance = new Decimal(portfolioHolding.balance || '0');
          const value = new Decimal(portfolioHolding.value || '0');
          // Calculate price = value / balance (avoid division by zero)
          const price = balance.isZero() ? '0' : value.div(balance).toString();
          // Store price by token symbol (we can safely overwrite since price is the same for the same token)
          tokenPriceMap.set(portfolioHolding.tokenSymbol, price);
        } catch (error) {
          this.logWarning('Failed to calculate price for token', {
            tokenSymbol: portfolioHolding.tokenSymbol,
            balance: portfolioHolding.balance,
            value: portfolioHolding.value,
            error: error instanceof Error ? error.message : String(error),
          });
          // Set price to 0 for this token if calculation fails
          tokenPriceMap.set(portfolioHolding.tokenSymbol, '0');
        }
      }

      // Build summary for each institution
      const institutionsWithSummary = institutions.map((institution) => {
        const institutionAccounts = accountsByInstitution.get(institution.id) || [];
        const accountCount = institutionAccounts.length;

        // Calculate total value across all accounts in this institution
        let totalValue = new Decimal(0);
        for (const account of institutionAccounts) {
          const accountHoldings = holdingsByAccount.get(account.id) || [];
          for (const holding of accountHoldings) {
            const token = tokenMap.get(holding.tokenId);
            if (token) {
              try {
                // Calculate value = balance * price for this specific holding
                const price = new Decimal(tokenPriceMap.get(token.symbol) || '0');
                const balance = new Decimal(holding.balance || '0');
                const holdingValue = balance.mul(price);
                totalValue = totalValue.add(holdingValue);
              } catch (error) {
                this.logWarning('Failed to calculate holding value', {
                  holdingId: holding.id,
                  tokenSymbol: token.symbol,
                  balance: holding.balance,
                  error: error instanceof Error ? error.message : String(error),
                });
                // Skip this holding if calculation fails
              }
            }
          }
        }

        return {
          ...institution,
          summary: {
            accountCount,
            totalValue: totalValue.toString(),
          },
        };
      });

      this.logInfo('Institutions with summary retrieved', {
        userId,
        count: institutionsWithSummary.length,
      });

      return institutionsWithSummary;
    } catch (error) {
      throw this.handleError(error, 'getInstitutionsByUserIdWithSummary');
    }
  }
}
