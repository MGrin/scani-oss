import type {
  CreateHoldingsWithDependenciesInput,
  CreateHoldingsWithDependenciesResponseDto,
} from '@scani/shared';
import Container, { Service } from 'typedi';
import type { User } from '../../domain/entities';
import { getDb } from '../../infrastructure/database/connection';
import { createComponentLogger } from '../../utils/logger';
import { AccountService } from '../services/AccountService';
import { HoldingService } from '../services/HoldingService';
import { InstitutionService } from '../services/InstitutionService';
import { PortfolioValuationService } from '../services/PortfolioValuationService';

const logger = createComponentLogger('use-case:create-holdings-with-dependencies');

@Service()
export class CreateHoldingsWithDependenciesUseCase {
  private readonly institutionService = Container.get(InstitutionService);
  private readonly accountService = Container.get(AccountService);
  private readonly holdingService = Container.get(HoldingService);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  async execute(
    input: CreateHoldingsWithDependenciesInput,
    user: User
  ): Promise<CreateHoldingsWithDependenciesResponseDto> {
    const result = await getDb().transaction(async (tx) => {
      if (!user.baseCurrencyId) {
        throw new Error('User must have a base currency set');
      }

      const userId = user.id;
      logger.debug(
        {
          userId,
          accountId: input.accountId,
          hasInstitution: !!input.institution,
          hasAccount: !!input.account,
          holdingsCount: input.holdings.length,
          holdings: input.holdings.map((h) => ({
            tokenId: h.tokenId,
            balance: h.balance,
          })),
        },
        'Creating holdings with dependencies'
      );
      let accountId: string;
      let institutionId: string | undefined;
      let createdAccount = false;
      let createdInstitution = false;

      // Step 1: Ensure we have an accountId
      if (input.accountId) {
        // Use existing account
        accountId = input.accountId;
        logger.debug({ userId, accountId }, 'Using existing account');
      } else {
        // Need to create account
        if (!input.account) {
          throw new Error('Either accountId or account details must be provided');
        }

        if (!input.account.institutionId) {
          // Need to create institution
          if (!input.institution) {
            throw new Error(
              'Institution details are required when creating new account without institutionId'
            );
          }

          logger.debug(
            { userId, institutionName: input.institution.name },
            'Creating new institution'
          );

          const institution = await this.institutionService.createInstitution(
            input.institution,
            userId,
            tx
          );

          logger.debug(
            { userId, institutionId: institution.id, account: input.account },
            'Creating account with new institution'
          );
          const account = await this.accountService.createAccount(
            {
              ...input.account,
              institutionId: institution.id,
            },
            userId,
            tx
          );

          institutionId = institution.id;
          accountId = account.id;
          createdInstitution = true;
          createdAccount = true;

          logger.info({ userId, institutionId, accountId }, 'Created institution and account');
        } else {
          // Use existing institution, create account only
          institutionId = input.account.institutionId;

          logger.debug({ userId, institutionId }, 'Creating account with existing institution');

          const account = await this.accountService.createAccount(input.account, userId, tx);

          accountId = account.id;
          createdAccount = true;

          logger.info({ userId, institutionId, accountId }, 'Created account');
        }
      }

      logger.info(
        {
          userId,
          accountId,
          totalHoldings: input.holdings.length,
          holdingsToCreate: input.holdings.length,
          holdingsToCreateDetails: input.holdings.map((h) => ({
            tokenId: h.tokenId,
            balance: h.balance,
          })),
        },
        'Creating holdings for account'
      );

      const account = await this.accountService.getAccountById(userId, accountId, tx);
      if (account.userId !== userId) {
        throw new Error('Account does not belong to the user');
      }

      const createdHoldings = await this.holdingService.createManyHoldings(
        input.holdings.map((h) => {
          return {
            accountId,
            tokenId: h.tokenId!,
            balance: h.balance,
          };
        }),
        userId,
        tx
      );

      logger.info(
        {
          userId,
          accountId,
          institutionId,
          createdAccount,
          createdInstitution,
          holdingsCreated: createdHoldings.length,
        },
        'Completed creating holdings with dependencies'
      );

      return {
        institutionId: account.institutionId,
        accountId,
        holdings: createdHoldings,
        createdInstitution,
        createdAccount,
      };
    });

    await this.portfolioValuationService.getUserPortfolioValue(
      user.id,
      user.baseCurrencyId!,
      result.accountId
    );
    return result;
  }
}
