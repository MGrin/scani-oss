import type { DatabaseTransaction } from '@scani/db';
import type { Institution } from '@scani/db/schema';
import type { CreateInstitutionInput } from '@scani/shared';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { InstitutionRepository } from '../../repositories/InstitutionRepository';
import { PortfolioValueDailyRepository } from '../../repositories/PortfolioValueDailyRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { BaseService } from '../BaseService';

@Service()
export class InstitutionService extends BaseService {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly userRepository = Container.get(UserRepository);
  private readonly dailyRepository = Container.get(PortfolioValueDailyRepository);

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
   * Reads `totalValue` from the `portfolio_value_daily` rollup cache
   * instead of running a live valuation per request. Previously this
   * endpoint took ~1s and held ~110 holdings + token prices in memory
   * per call — under concurrent page-loads it OOM-killed the backend
   * (exit 137, 2026-05-06). The rollup is recomputed nightly + on
   * every chart-affecting job, so the value is at most one day stale.
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

      const baseCurrencyId = user?.baseCurrencyId ?? null;
      const latestByScope = baseCurrencyId
        ? await this.dailyRepository.findLatestForScopes(
            userId,
            baseCurrencyId,
            institutions.map((i) => ({ kind: 'institution' as const, id: i.id }))
          )
        : new Map();

      return institutions.map((institution) => ({
        ...institution,
        summary: {
          accountCount: accountCountByInstitution.get(institution.id) ?? 0,
          totalValue: latestByScope.get(`institution:${institution.id}`)?.totalValue ?? '0',
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

      const baseCurrencyId = user?.baseCurrencyId ?? null;
      const latestByScope = baseCurrencyId
        ? await this.dailyRepository.findLatestForScopes(userId, baseCurrencyId, [
            { kind: 'institution', id: institutionId },
          ])
        : new Map();

      return {
        ...institution,
        summary: {
          accountCount: ownAccounts.length,
          totalValue: latestByScope.get(`institution:${institutionId}`)?.totalValue ?? '0',
        },
      };
    } catch (error) {
      throw this.handleError(error, 'getInstitutionByIdWithSummary');
    }
  }
}
