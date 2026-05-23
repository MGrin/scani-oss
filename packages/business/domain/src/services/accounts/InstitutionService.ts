import type { DatabaseTransaction } from '@scani/db';
import type { Institution } from '@scani/db/schema';
import type { CreateInstitutionInput } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { InstitutionRepository } from '../../repositories/InstitutionRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { BaseService } from '../BaseService';
import {
  PortfolioValuationService,
  sumPortfolioValuesByAccount,
} from '../portfolio/PortfolioValuationService';

@Service()
export class InstitutionService extends BaseService {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly userRepository = Container.get(UserRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

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
   * Institutions for a user, each annotated with `summary.accountCount`
   * + `summary.totalValue`.
   *
   * `totalValue` is a LIVE current valuation: one
   * `getUserPortfolioValue` pass for the whole user, bucketed by
   * `accountId` and rolled up to the institution via the
   * account→institution map. One valuation per request (the same
   * computation the dashboard already runs) — this removes the
   * per-institution N valuations that OOM-killed the backend (exit
   * 137, 2026-05-06), rather than scaling them. The
   * `portfolio_value_daily` rollup remains the source for the
   * historical chart; only the current total is live.
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
      const [institutions, accounts, user] = await Promise.all([
        this.institutionRepository.findByUserId(userId),
        this.accountRepository.findByUser(userId),
        this.userRepository.findById(userId),
      ]);
      if (institutions.length === 0) return [];

      const accountCountByInstitution = new Map<string, number>();
      for (const account of accounts) {
        accountCountByInstitution.set(
          account.institutionId,
          (accountCountByInstitution.get(account.institutionId) ?? 0) + 1
        );
      }

      const portfolio = user?.baseCurrencyId
        ? await this.portfolioValuationService.getUserPortfolioValue(userId, user.baseCurrencyId)
        : null;
      const valueByInstitution = rollUpToInstitution(portfolio, accounts);

      return institutions.map((institution) => ({
        ...institution,
        summary: {
          accountCount: accountCountByInstitution.get(institution.id) ?? 0,
          totalValue: (valueByInstitution.get(institution.id) ?? new Decimal(0)).toString(),
        },
      }));
    } catch (error) {
      throw this.handleError(error, 'getInstitutionsByUserIdWithSummary');
    }
  }

  /**
   * Single-institution variant of `getInstitutionsByUserIdWithSummary`.
   * Detail pages don't need the whole list — fetching it just to
   * `.find()` one institution wastes a round-trip and forces the API
   * to compute summaries for every other institution too.
   */
  async getInstitutionByIdWithSummary(
    userId: string,
    institutionId: string
  ): Promise<
    | (Institution & {
        summary: { accountCount: number; totalValue: string };
      })
    | null
  > {
    try {
      const [institution, accounts, user] = await Promise.all([
        this.institutionRepository.findById(institutionId),
        this.accountRepository.findByUser(userId),
        this.userRepository.findById(userId),
      ]);
      if (!institution) return null;
      // Ownership check via account membership — same pattern used by
      // the chart endpoint's `assertScopeOwnership`. An institution row
      // is global; the user's "ownership" is having ≥1 account there.
      const ownAccounts = accounts.filter((a) => a.institutionId === institutionId);
      if (ownAccounts.length === 0) return null;

      const portfolio = user?.baseCurrencyId
        ? await this.portfolioValuationService.getUserPortfolioValue(userId, user.baseCurrencyId)
        : null;
      const totalValue =
        rollUpToInstitution(portfolio, ownAccounts).get(institutionId) ?? new Decimal(0);

      return {
        ...institution,
        summary: {
          accountCount: ownAccounts.length,
          totalValue: totalValue.toString(),
        },
      };
    } catch (error) {
      throw this.handleError(error, 'getInstitutionByIdWithSummary');
    }
  }
}

/**
 * Rolls a whole-user portfolio valuation up to per-institution current
 * totals, via the account→institution map. Only accounts in the
 * supplied list contribute, so a caller can scope the rollup.
 */
function rollUpToInstitution(
  portfolio: Parameters<typeof sumPortfolioValuesByAccount>[0],
  accounts: Array<{ id: string; institutionId: string }>
): Map<string, Decimal> {
  const valueByAccount = sumPortfolioValuesByAccount(portfolio);
  const valueByInstitution = new Map<string, Decimal>();
  for (const account of accounts) {
    const accountValue = valueByAccount.get(account.id);
    if (!accountValue) continue;
    valueByInstitution.set(
      account.institutionId,
      (valueByInstitution.get(account.institutionId) ?? new Decimal(0)).add(accountValue)
    );
  }
  return valueByInstitution;
}
