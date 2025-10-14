import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import {
  AccountTypeRepository,
  InstitutionTypeRepository,
  TokenTypeRepository,
} from '../../infrastructure/repositories/EnumRepositories';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { createComponentLogger } from '../../utils/logger';
import { PortfolioValuationService } from '../services/PortfolioValuationService';

const logger = createComponentLogger('use-case:get-holdings-with-details');

export interface HoldingWithDetails {
  id: string;
  token: {
    symbol: string;
    name: string;
    type: string;
    typeCode: string;
  };
  amount: string;
  value: string;
  costBasis: string;
  account: {
    id: string;
    name: string;
    type: string;
  };
  institution: {
    id: string;
    name: string;
    type: string;
  };
  lastUpdated: string;
}

/**
 * Use case for getting all holdings with full details
 *
 * This use case aggregates data from multiple repositories and services to provide
 * comprehensive holding information for the frontend Holdings page.
 *
 * Note: Performance/P&L calculations are not included as accurate computation methods
 * are not currently available.
 */
@Service()
export class GetHoldingsWithDetailsUseCase {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly accountTypeRepository = Container.get(AccountTypeRepository);
  private readonly institutionTypeRepository = Container.get(InstitutionTypeRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  async execute(userId: string, baseCurrencyId?: string): Promise<HoldingWithDetails[]> {
    logger.debug({ userId }, 'Getting holdings with details');

    // Get all holdings for user
    const holdings = await this.holdingRepository.findByUser(userId);

    if (holdings.length === 0) {
      return [];
    }

    // Get portfolio valuation to get current values and prices
    const portfolioValue = await this.portfolioValuationService.getUserPortfolioValue(
      userId,
      baseCurrencyId
    );

    // Create maps for efficient lookups - get individual token prices, not total values
    const portfolioPriceMap = new Map(
      portfolioValue.holdings.map((h) => [h.tokenSymbol, h.currentPrice || '0'])
    );

    // Get all unique IDs for batch fetching
    const uniqueTokenIds = [...new Set(holdings.map((h) => h.tokenId))];
    const uniqueAccountIds = [...new Set(holdings.map((h) => h.accountId))];

    // Batch fetch related entities
    const [tokens, accounts] = await Promise.all([
      this.tokenRepository.findByIds(uniqueTokenIds),
      this.accountRepository.findByIds(uniqueAccountIds),
    ]);

    // Create lookup maps
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    // Get unique institution IDs from accounts
    const uniqueInstitutionIds = [...new Set(accounts.map((a) => a.institutionId))];
    const institutions = await this.institutionRepository.findByIds(uniqueInstitutionIds);
    const institutionMap = new Map(institutions.map((i) => [i.id, i]));

    // Get unique token type IDs
    const uniqueTokenTypeIds = [...new Set(tokens.map((t) => t.typeId))];
    const tokenTypes = await this.tokenTypeRepository.findByIds(uniqueTokenTypeIds);
    const tokenTypeMap = new Map(tokenTypes.map((tt) => [tt.id, tt]));

    // Get unique account type IDs
    const uniqueAccountTypeIds = [...new Set(accounts.map((a) => a.typeId))];
    const accountTypes = await this.accountTypeRepository.findByIds(uniqueAccountTypeIds);
    const accountTypeMap = new Map(accountTypes.map((at) => [at.id, at]));

    // Get unique institution type IDs
    const uniqueInstitutionTypeIds = [...new Set(institutions.map((i) => i.typeId))];
    const institutionTypes =
      await this.institutionTypeRepository.findByIds(uniqueInstitutionTypeIds);
    const institutionTypeMap = new Map(institutionTypes.map((it) => [it.id, it]));

    // Build detailed holdings
    const detailedHoldings: HoldingWithDetails[] = [];

    for (const holding of holdings) {
      const token = tokenMap.get(holding.tokenId);
      const account = accountMap.get(holding.accountId);

      if (!token || !account) {
        logger.warn(
          {
            holdingId: holding.id,
            tokenId: holding.tokenId,
            accountId: holding.accountId,
          },
          'Missing token or account for holding'
        );
        continue;
      }

      const institution = institutionMap.get(account.institutionId);
      const tokenType = tokenTypeMap.get(token.typeId);
      const accountType = accountTypeMap.get(account.typeId);

      if (!institution || !tokenType || !accountType) {
        logger.warn(
          {
            holdingId: holding.id,
            institutionId: account.institutionId,
            tokenTypeId: token.typeId,
            accountTypeId: account.typeId,
          },
          'Missing institution, token type, or account type for holding'
        );
        continue;
      }

      const institutionType = institutionTypeMap.get(institution.typeId);

      // Get current price and calculate individual holding value
      const currentPrice = portfolioPriceMap.get(token.symbol) || '0';
      const currentValue = new Decimal(holding.balance).mul(new Decimal(currentPrice)).toString();

      // For now, cost basis is the same as current value (simplified)
      // In a real implementation, this would be calculated from transactions
      const costBasis = currentValue;

      const detailedHolding: HoldingWithDetails = {
        id: holding.id,
        token: {
          symbol: token.symbol,
          name: token.name,
          type: tokenType.name,
          typeCode: tokenType.code,
        },
        amount: holding.balance,
        value: currentValue,
        costBasis: costBasis,
        account: {
          id: account.id,
          name: account.name,
          type: accountType.name,
        },
        institution: {
          id: institution.id,
          name: institution.name,
          type: institutionType?.name || 'Unknown',
        },
        lastUpdated: holding.lastUpdated.toISOString(),
      };

      detailedHoldings.push(detailedHolding);
    }

    logger.debug({ userId, count: detailedHoldings.length }, 'Holdings with details retrieved');

    return detailedHoldings;
  }
}
