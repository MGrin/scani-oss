import type { CreateInstitutionInput } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { Institution } from '../../domain/entities';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import type { DatabaseTransaction } from '../../infrastructure/repositories/BaseRepository';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
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
      const portfolioValue = await this.portfolioService.getUserPortfolioValue(userId);

      // Create maps for efficient lookups
      const holdingsByAccount = new Map<string, typeof holdings>();
      for (const holding of holdings) {
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

      // Create value map from portfolio data (token symbol -> total value for that token)
      const valueMap = new Map(portfolioValue.holdings.map((h) => [h.tokenSymbol, h.value || '0']));

      // Get token repository to map holding tokenIds to symbols
      const tokenIds = [...new Set(holdings.map((h) => h.tokenId))];
      const tokens = await this.tokenRepository.findByIds(tokenIds);
      const tokenMap = new Map(tokens.map((t) => [t.id, t]));

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
              const holdingValue = valueMap.get(token.symbol) || '0';
              totalValue = totalValue.add(new Decimal(holdingValue));
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
