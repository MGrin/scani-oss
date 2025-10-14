import { Container, Service } from 'typedi';
import type { CreateAccountInput } from '../../domain/dtos/account';
import type { CreateHoldingInput } from '../../domain/dtos/holding';
import type { CreateInstitutionInput } from '../../domain/dtos/institution';
import type { CreateTokenInput } from '../../domain/dtos/token';
import type { CreateTokenPriceInput } from '../../domain/dtos/token-price';
import { AccountService } from './AccountService';
import { BaseService } from './BaseService';
import { HoldingService } from './HoldingService';
import { InstitutionService } from './InstitutionService';
import { TokenPriceService } from './TokenPriceService';
import { TokenService } from './TokenService';

interface CreateHoldingWithDependenciesInput {
  institution?: {
    name: string;
    typeCode: string;
    description?: string;
  };
  account: {
    institutionId?: string;
    name: string;
    typeCode: string;
    description?: string;
  };
  token?: CreateTokenInput;
  holding: {
    tokenId?: string;
    balance: string;
    lastUpdated?: Date;
  };
}

interface CreateHoldingWithDependenciesResult {
  institutionId?: string;
  accountId: string;
  tokenId: string;
  holdingId: string;
  createdInstitution?: boolean;
  createdAccount: boolean;
  createdToken?: boolean;
  createdHolding: boolean;
}

/**
 * BatchOperationsService
 *
 * Handles atomic multi-entity operations using Unit of Work pattern.
 * Ensures all-or-nothing semantics for complex operations.
 */
@Service()
export class BatchOperationsService extends BaseService {
  private readonly tokenService = Container.get(TokenService);
  private readonly institutionService = Container.get(InstitutionService);
  private readonly accountService = Container.get(AccountService);
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenPriceService = Container.get(TokenPriceService);

  constructor() {
    super('BatchOperationsService');
  }

  /**
   * Create holding with all dependencies atomically
   *
   * This ensures either ALL entities are created or NONE are created.
   * Prevents orphaned institutions/accounts when holding creation fails.
   */
  async createHoldingWithDependencies(
    input: CreateHoldingWithDependenciesInput,
    userId: string
  ): Promise<CreateHoldingWithDependenciesResult> {
    try {
      this.logInfo('Creating holding with dependencies', { userId });

      return await this.withTransaction(async (_tx) => {
        let institutionId: string | undefined;
        let createdInstitution = false;
        let tokenId: string;
        let createdToken = false;

        // Step 1: Create or use existing institution
        if (input.institution) {
          this.logDebug('Creating institution', { name: input.institution.name });

          const institution = await this.institutionService.createInstitution(
            {
              name: input.institution.name,
              typeCode: input.institution.typeCode,
              description: input.institution.description,
            },
            userId
          );

          institutionId = institution.id;
          createdInstitution = true;
          this.logDebug('Institution created', { institutionId });
        } else {
          institutionId = input.account.institutionId;
        }

        this.assertExists(institutionId, 'Institution ID is required');

        // Step 2: Create account
        this.logDebug('Creating account', { institutionId, name: input.account.name });

        const account = await this.accountService.createAccount(
          {
            name: input.account.name,
            typeCode: input.account.typeCode,
            institutionId: institutionId!,
            description: input.account.description,
          },
          userId
        );

        const accountId = account.id;
        this.logDebug('Account created', { accountId });

        // Step 3: Create or use existing token
        if (input.token) {
          this.logDebug('Creating token', { symbol: input.token.symbol });

          const token = await this.tokenService.createToken(input.token);
          tokenId = token.id;
          createdToken = true;
          this.logDebug('Token created', { tokenId });
        } else {
          tokenId = input.holding.tokenId!;
          this.assertExists(tokenId, 'Token ID is required when not creating token');
        }

        // Step 4: Create holding
        this.logDebug('Creating holding', { accountId, tokenId, balance: input.holding.balance });

        const holding = await this.holdingService.createHolding(
          {
            accountId,
            tokenId,
            balance: input.holding.balance,
            lastUpdated: input.holding.lastUpdated || new Date(),
          },
          userId
        );

        this.logInfo('Holding with dependencies created successfully', {
          holdingId: holding.id,
          accountId,
          tokenId,
          institutionId,
        });

        return {
          institutionId,
          accountId,
          tokenId,
          holdingId: holding.id,
          createdInstitution,
          createdAccount: true,
          createdToken,
          createdHolding: true,
        };
      });
    } catch (error) {
      throw this.handleError(error, 'createHoldingWithDependencies');
    }
  }

  /**
   * Batch create multiple holdings
   */
  async batchCreateHoldings(
    holdings: CreateHoldingInput[],
    userId: string
  ): Promise<{ success: boolean; created: number; failed: number }> {
    try {
      this.logInfo('Batch creating holdings', { count: holdings.length, userId });

      let created = 0;
      let failed = 0;

      for (const holdingData of holdings) {
        try {
          await this.holdingService.createHolding(holdingData, userId);
          created++;
        } catch (error) {
          this.logWarning('Failed to create holding in batch', {
            holdingData,
            error,
          });
          failed++;
        }
      }

      this.logInfo('Batch create holdings completed', { created, failed });

      return {
        success: failed === 0,
        created,
        failed,
      };
    } catch (error) {
      throw this.handleError(error, 'batchCreateHoldings');
    }
  }

  /**
   * Batch update prices for multiple tokens
   */
  async batchUpdatePrices(
    prices: CreateTokenPriceInput[],
    _userId: string
  ): Promise<{ success: boolean; updated: number; failed: number }> {
    try {
      this.logInfo('Batch updating prices', { count: prices.length });

      const result = await this.tokenPriceService.bulkUpsertPrices(prices);

      this.logInfo('Batch price update completed', { updated: result });

      return {
        success: result === prices.length,
        updated: result,
        failed: prices.length - result,
      };
    } catch (error) {
      throw this.handleError(error, 'batchUpdatePrices');
    }
  }

  /**
   * Import complete portfolio atomically
   *
   * Creates institutions, accounts, tokens, and holdings in one transaction
   */
  async importPortfolio(
    data: {
      institutions: Array<
        CreateInstitutionInput & {
          accounts: Array<
            CreateAccountInput & {
              holdings: Array<
                CreateHoldingInput & {
                  token?: CreateTokenInput;
                }
              >;
            }
          >;
        }
      >;
    },
    userId: string
  ): Promise<{
    success: boolean;
    institutionsCreated: number;
    accountsCreated: number;
    holdingsCreated: number;
    tokensCreated: number;
  }> {
    try {
      this.logInfo('Importing portfolio', {
        userId,
        institutionCount: data.institutions.length,
      });

      return await this.withTransaction(async (_tx) => {
        let institutionsCreated = 0;
        let accountsCreated = 0;
        let holdingsCreated = 0;
        let tokensCreated = 0;

        for (const institutionData of data.institutions) {
          // Create institution
          const institution = await this.institutionService.createInstitution(
            {
              name: institutionData.name,
              typeCode: institutionData.typeCode,
              description: institutionData.description,
            },
            userId
          );
          institutionsCreated++;

          // Create accounts for this institution
          for (const accountData of institutionData.accounts) {
            const account = await this.accountService.createAccount(
              {
                name: accountData.name,
                typeCode: accountData.typeCode,
                institutionId: institution.id,
                description: accountData.description,
              },
              userId
            );
            accountsCreated++;

            // Create holdings for this account
            for (const holdingData of accountData.holdings) {
              let tokenId = holdingData.tokenId;

              // Create token if needed
              if (holdingData.token && !tokenId) {
                const token = await this.tokenService.createToken(holdingData.token);
                tokenId = token.id;
                tokensCreated++;
              }

              if (tokenId) {
                await this.holdingService.createHolding(
                  {
                    accountId: account.id,
                    tokenId,
                    balance: holdingData.balance,
                    lastUpdated: holdingData.lastUpdated,
                  },
                  userId
                );
                holdingsCreated++;
              }
            }
          }
        }

        this.logInfo('Portfolio import completed', {
          institutionsCreated,
          accountsCreated,
          holdingsCreated,
          tokensCreated,
        });

        return {
          success: true,
          institutionsCreated,
          accountsCreated,
          holdingsCreated,
          tokensCreated,
        };
      });
    } catch (error) {
      throw this.handleError(error, 'importPortfolio');
    }
  }
}
