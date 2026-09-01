import type { DatabaseTransaction } from '@scani/db';
import type { User } from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import {
  type CreateHoldingsWithDependenciesInput,
  type CreateHoldingsWithDependenciesResponseDto,
  collidingHoldingTokens,
} from '@scani/shared';
import Container, { Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import {
  AccountService,
  HoldingService,
  InstitutionService,
  PortfolioValuationService,
} from '../services';

const logger = createComponentLogger('use-case:create-holdings-with-dependencies');

export interface UpdateExistingHoldingInput {
  holdingId: string;
  balance: string;
}

/**
 * A create that would give one account two unsynced rows for the same token
 * under the same name.
 *
 * Carries the token ids rather than a rendered sentence: the caller has the
 * symbols the user typed, this layer has only uuids, and a message naming
 * `a uuid` instead of `RUB` is a message nobody can act on. The worker
 * resolves them before the user sees anything.
 */
export class DuplicateHoldingTokenError extends Error {
  constructor(
    readonly tokenIds: string[],
    readonly accountId: string
  ) {
    super(
      `Account ${accountId} would end up with more than one holding for token(s) ${tokenIds.join(', ')}`
    );
    this.name = 'DuplicateHoldingTokenError';
  }
}

export interface PositionKeyInput {
  tokenId: string;
  label?: string | null;
}

/**
 * The token ids this payload would duplicate — a position key repeated inside
 * `requested`, or already held unsynced by the account.
 *
 * Pure and exported because the outcome test cannot catch the regression on
 * its own: today's code creates a row per entry and every row it creates is
 * individually well-formed, so an assertion on "the holdings that came back"
 * passes against the broken version. The defect is a comparison that never
 * happens, which is what this function is.
 *
 * The comparison itself lives in `@scani/shared` so the review screen refuses
 * exactly what this refuses. Two implementations of that rule drift, and the
 * direction they drift in is a form that submits and then fails the job.
 *
 * Returns token ids, not keys: the caller renders symbols for a human, and
 * "RUB is on two rows" is the sentence to act on whatever the names were.
 */
export function duplicateTokenIds(
  requested: PositionKeyInput[],
  existing: PositionKeyInput[]
): string[] {
  return [...collidingHoldingTokens(requested, existing)];
}

@Service()
export class CreateHoldingsWithDependenciesUseCase {
  private readonly institutionService = Container.get(InstitutionService);
  private readonly accountService = Container.get(AccountService);
  private readonly holdingService = Container.get(HoldingService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  async execute(
    input: CreateHoldingsWithDependenciesInput & {
      updateHoldings?: UpdateExistingHoldingInput[];
    },
    user: User,
    // Caller-owned transaction. Only the tests pass one, and they have to:
    // without it this opens and COMMITS its own, so a rollback-isolated test
    // could not contain the rows it creates. When one is passed the caller
    // also owns what happens after commit, which is why the valuation below
    // is skipped — pricing a portfolio from inside the uncommitted write that
    // changed it reads the old numbers.
    transaction?: DatabaseTransaction
  ): Promise<
    CreateHoldingsWithDependenciesResponseDto & {
      updatedHoldingIds: string[];
    }
  > {
    // Use new withTransaction helper for better error handling and logging
    const run = async (tx: DatabaseTransaction) => {
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
            'Resolving institution for new account'
          );

          const ensured = await this.institutionService.ensureInstitution(
            input.institution,
            userId,
            tx
          );
          const institution = ensured.institution;

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
          createdInstitution = ensured.created;
          createdAccount = true;

          logger.info(
            { userId, institutionId, accountId, institutionCreated: ensured.created },
            'Resolved institution and created account'
          );
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

      // The only thing standing between this payload and a second unsynced
      // row for a position the account already holds. `holdings` has no
      // uniqueness on (account_id, token_id) (SC-303), and the split into
      // `holdings` vs `updateHoldings` is made by the CLIENT — the v3
      // manual-entry form hardcodes `updateHoldings: []`, so a client that
      // gets it wrong lands here with nothing to stop it. Two of the three
      // duplicate groups in production came through this call: four RUB rows
      // in one Tinkoff payload and two USD rows in one Revolut payload. The
      // third (a hand-entered USD row beside an `import_airwallex` one) is
      // deliberately still allowed — see `findUnsyncedByAccountAndTokens`.
      const existingUnsynced = await this.holdingRepository.findUnsyncedByAccountAndTokens(
        accountId,
        input.holdings.map((h) => h.tokenId!),
        userId,
        tx
      );
      const duplicates = duplicateTokenIds(
        input.holdings.map((h) => ({ tokenId: h.tokenId!, label: h.label })),
        existingUnsynced
      );
      if (duplicates.length > 0) {
        // Refused, not merged. Two unnamed lines for one token can mean
        // "these are parts of one position, add them up" or "I entered it
        // twice", and summing the second reading silently inflates a balance.
        // The person who knows is in front of the form — and now has
        // somewhere to say it, by naming each pot (SC-330). Refusing is only
        // right while the payload leaves the two readings indistinguishable.
        throw new DuplicateHoldingTokenError(duplicates, accountId);
      }

      const createdHoldings = await this.holdingService.createManyHoldingsWithEvents(
        input.holdings.map((h) => {
          return {
            accountId,
            tokenId: h.tokenId!,
            balance: h.balance,
            // Empty is not a name — it is the absence of one, and the
            // position key already treats it that way.
            label: h.label?.trim() ? h.label.trim() : null,
            userId,
            source: 'manual',
            // The user typed this position in (SC-277).
            arrival: 'user_confirmed' as const,
            eventContext: {
              baseCurrencyId: user.baseCurrencyId!,
            },
          };
        }),
        tx
      );

      const updatedHoldingIds: string[] = [];
      for (const update of input.updateHoldings ?? []) {
        const existing = await this.holdingRepository.findById(update.holdingId, tx);
        if (!existing) {
          throw new Error(`Holding ${update.holdingId} not found`);
        }
        if (existing.userId !== userId) {
          throw new Error(`Holding ${update.holdingId} does not belong to the user`);
        }
        await this.holdingService.updateHoldingBalance(update.holdingId, update.balance, tx);
        updatedHoldingIds.push(update.holdingId);
      }

      logger.info(
        {
          userId,
          accountId,
          institutionId,
          createdAccount,
          createdInstitution,
          holdingsCreated: createdHoldings.length,
          holdingsUpdated: updatedHoldingIds.length,
        },
        'Completed creating holdings with dependencies'
      );

      return {
        institutionId: account.institutionId,
        accountId,
        holdings: createdHoldings,
        createdInstitution,
        createdAccount,
        updatedHoldingIds,
      };
    };

    if (transaction) return await run(transaction);

    const result = await withTransaction(run, {
      name: 'create-holdings-with-dependencies',
      timeout: 30000, // Longer timeout for complex operation
    });

    // CRITICAL IMPROVEMENT: Portfolio valuation happens AFTER transaction commits
    // This separates the external API call (pricing) from database operations
    // Connection is released before potentially slow price fetching occurs
    await this.portfolioValuationService.getUserPortfolioValue(
      user.id,
      user.baseCurrencyId!,
      result.accountId
    );

    return result;
  }
}
