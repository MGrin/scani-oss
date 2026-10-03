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
  sumPortfolioDebtByAccount,
  sumPortfolioValuesByAccount,
} from '../portfolio/PortfolioValuationService';

type InstitutionSummary = {
  accountCount: number;
  /** Net: assets plus `marginDebt`. */
  totalValue: string;
  /** Signed: `"0"`, or the negative sum of its accounts' debt (SC-1463). */
  marginDebt: string;
};

@Service()
export class InstitutionService extends BaseService {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly userRepository = Container.get(UserRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  constructor() {
    super('InstitutionService');
  }

  /**
   * The institution for this name, creating it only if nothing matches.
   *
   * Returns `created` so callers can report what actually happened —
   * `CreateHoldingsWithDependenciesUseCase` emits an `institution.create`
   * realtime event off it, and firing that for a row it merely looked up
   * would be the same kind of false claim in a different place.
   */
  async ensureInstitution(
    data: CreateInstitutionInput,
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<{ institution: Institution; created: boolean }> {
    try {
      this.logInfo('Ensuring institution', { name: data.name, userId });

      this.validateRequiredFields(data, ['name', 'typeId']);
      this.validateNonEmptyString(data.name, 'name');

      // Reuse before insert. There is no unique constraint on `name`, and the
      // capture flow's "Add <name>" affordance sits directly under the matching
      // existing row — so the ordinary mis-tap produced a second, identical
      // institution holding none of the user's accounts, and the next import
      // reported their account as missing (SC-135). Only rows this user may
      // see are reused; another user's typed row is not (SC-1354).
      const existing = await this.institutionRepository.findByNameInsensitive(
        data.name,
        userId,
        tx
      );
      if (existing) {
        this.logInfo('Reusing existing institution with the same name', {
          institutionId: existing.id,
          name: existing.name,
          userId,
        });
        return { institution: existing, created: false };
      }

      const institution = await this.institutionRepository.create(
        {
          name: data.name,
          typeId: data.typeId,
          description: data.description || null,
          website: data.website || null,
          logoUrl: data.logoUrl || null,
          isActive: true,
          // A typed institution is the creator's until someone verifies it.
          isVerified: false,
          createdByUserId: userId,
        },
        tx
      );

      this.logInfo('Institution created', { institutionId: institution.id });
      return { institution, created: true };
    } catch (error) {
      throw this.handleError(error, 'ensureInstitution');
    }
  }

  /**
   * The shared institution for a site, creating it verified if none exists
   * (SC-1354, mgrin 2026-09-26). Every field here comes from the server's own
   * scrape of `https://<host>`; the caller must never pass client input as
   * `name`, `description` or `logoUrl`, or anyone could publish anything to
   * every user's picker under a real site's name.
   *
   * Two concurrent first creations of one site race on the verified-website
   * unique index; the loser reads the winner's row.
   */
  async ensureFromSite(site: {
    host: string;
    name: string;
    description: string | null;
    logoUrl: string | null;
    typeId: string;
  }): Promise<{ institution: Institution; created: boolean }> {
    const existing = await this.institutionRepository.findVerifiedBySiteHost(site.host);
    if (existing) return { institution: existing, created: false };
    try {
      const institution = await this.institutionRepository.create({
        name: site.name,
        typeId: site.typeId,
        description: site.description,
        website: `https://${site.host}`,
        logoUrl: site.logoUrl,
        isActive: true,
        isVerified: true,
        createdByUserId: null,
      });
      this.logInfo('Shared institution created from its site', {
        institutionId: institution.id,
        host: site.host,
      });
      return { institution, created: true };
    } catch (error) {
      const raced = await this.institutionRepository.findVerifiedBySiteHost(site.host);
      if (raced) return { institution: raced, created: false };
      throw this.handleError(error, 'ensureFromSite');
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
  async getInstitutionsByUserIdWithSummary(
    userId: string
  ): Promise<Array<Institution & { summary: InstitutionSummary }>> {
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
      const valueByInstitution = rollUpToInstitution(
        sumPortfolioValuesByAccount(portfolio),
        accounts
      );
      const debtByInstitution = rollUpToInstitution(sumPortfolioDebtByAccount(portfolio), accounts);

      return institutions.map((institution) => ({
        ...institution,
        summary: {
          accountCount: accountCountByInstitution.get(institution.id) ?? 0,
          totalValue: (valueByInstitution.get(institution.id) ?? new Decimal(0)).toString(),
          marginDebt: (debtByInstitution.get(institution.id) ?? new Decimal(0)).toString(),
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
  ): Promise<(Institution & { summary: InstitutionSummary }) | null> {
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
        rollUpToInstitution(sumPortfolioValuesByAccount(portfolio), ownAccounts).get(
          institutionId
        ) ?? new Decimal(0);
      const marginDebt =
        rollUpToInstitution(sumPortfolioDebtByAccount(portfolio), ownAccounts).get(institutionId) ??
        new Decimal(0);

      return {
        ...institution,
        summary: {
          accountCount: ownAccounts.length,
          totalValue: totalValue.toString(),
          marginDebt: marginDebt.toString(),
        },
      };
    } catch (error) {
      throw this.handleError(error, 'getInstitutionByIdWithSummary');
    }
  }
}

/**
 * Rolls per-account figures up to per-institution ones, via the
 * account→institution map. Only accounts in the supplied list contribute, so a
 * caller can scope the rollup.
 */
function rollUpToInstitution(
  byAccount: Map<string, Decimal>,
  accounts: Array<{ id: string; institutionId: string }>
): Map<string, Decimal> {
  const byInstitution = new Map<string, Decimal>();
  for (const account of accounts) {
    const accountFigure = byAccount.get(account.id);
    if (!accountFigure) continue;
    byInstitution.set(
      account.institutionId,
      (byInstitution.get(account.institutionId) ?? new Decimal(0)).add(accountFigure)
    );
  }
  return byInstitution;
}
