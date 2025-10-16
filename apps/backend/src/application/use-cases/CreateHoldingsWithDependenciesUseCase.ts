import Container, { Service } from "typedi";
import { createComponentLogger } from "../../utils/logger";
import { BatchOperationsService } from "../services";
import { CreateHoldingUseCase } from "./CreateHoldingUseCase";
import {
  AccountTypeRepository,
  InstitutionTypeRepository,
} from "../../infrastructure/repositories/EnumRepositories";

const logger = createComponentLogger(
  "use-case:create-holdings-with-dependencies"
);

export interface Institution {
  name: string;
  type: string;
  description?: string;
  website?: string;
  logoUrl?: string;
}

export interface Account {
  institutionId?: string;
  name: string;
  type: string;
  description?: string;
}

export interface Token {
  symbol: string;
  name?: string;
  typeId?: string;
  decimals?: number;
  iconUrl?: string;
}

export interface Holding {
  tokenId?: string;
  token?: Token;
  balance: string;
  lastUpdated?: Date;
}

export interface CreateHoldingsWithDependenciesInput {
  institution?: Institution;
  accountId?: string; // Use existing account
  account?: Account; // Create new account
  holdings: Holding[];
}

export interface CreateHoldingsWithDependenciesResult {
  institutionId?: string;
  accountId: string;
  holdings: Array<{
    holdingId: string;
    tokenId: string;
    createdToken?: boolean;
    createdHolding: boolean;
  }>;
  createdInstitution?: boolean;
  createdAccount: boolean;
}

/**
 * Use case for creating multiple holdings with their dependencies
 *
 * This use case:
 * - Handles two modes: existing account or new account creation
 * - Creates institution (optional) + account + holdings atomically
 * - Uses BatchOperationsService for institution/account/first holding
 * - Uses CreateHoldingUseCase for remaining holdings
 * - Returns comprehensive result with all created entities
 */
@Service()
export class CreateHoldingsWithDependenciesUseCase {
  private readonly batchOperationsService = Container.get(
    BatchOperationsService
  );
  private readonly createHoldingUseCase = Container.get(CreateHoldingUseCase);
  private readonly accountTypeRepository = Container.get(AccountTypeRepository);
  private readonly institutionTypeRepository = Container.get(
    InstitutionTypeRepository
  );

  /**
   * Helper method to resolve account type code from UUID or code
   */
  private async resolveAccountTypeCode(typeInput: string): Promise<string> {
    // Check if it's a UUID (contains dashes)
    if (typeInput.includes("-")) {
      const accountType = await this.accountTypeRepository.findById(typeInput);
      if (!accountType) {
        throw new Error(`Account type with ID ${typeInput} not found`);
      }
      return accountType.code;
    }
    // It's already a code
    return typeInput;
  }

  /**
   * Helper method to resolve institution type code from UUID or code
   */
  private async resolveInstitutionTypeCode(typeInput: string): Promise<string> {
    // Check if it's a UUID (contains dashes)
    if (typeInput.includes("-")) {
      const institutionType = await this.institutionTypeRepository.findById(
        typeInput
      );
      if (!institutionType) {
        throw new Error(`Institution type with ID ${typeInput} not found`);
      }
      return institutionType.code;
    }
    // It's already a code
    return typeInput;
  }

  async execute(
    input: CreateHoldingsWithDependenciesInput,
    userId: string
  ): Promise<CreateHoldingsWithDependenciesResult> {
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
      "Creating holdings with dependencies"
    );

    let accountId: string;
    let institutionId: string | undefined;
    let createdAccount = false;
    let createdInstitution = false;
    let firstHoldingCreated = false; // Track if first holding was created by BatchOperationsService
    let firstHoldingId = ""; // Store the ID of the first holding created by BatchOperationsService

    // Step 1: Ensure we have an accountId
    if (input.accountId) {
      // Use existing account
      accountId = input.accountId;
      logger.debug({ userId, accountId }, "Using existing account");
    } else {
      // Need to create account
      if (!input.account) {
        throw new Error("Either accountId or account details must be provided");
      }

      // Step 1a: Ensure we have an institutionId
      if (!input.account.institutionId || input.account.institutionId === "") {
        // Need to create institution
        if (!input.institution) {
          throw new Error(
            "Institution details are required when creating new account without institutionId"
          );
        }

        logger.debug(
          { userId, institutionName: input.institution.name },
          "Creating new institution"
        );

        // Resolve type codes (convert UUID to code if needed)
        const institutionTypeCode = await this.resolveInstitutionTypeCode(
          input.institution.type
        );
        const accountTypeCode = await this.resolveAccountTypeCode(
          input.account.type
        );

        // Create institution + account + first holding atomically
        const serviceInput = {
          institution: {
            name: input.institution.name,
            typeCode: institutionTypeCode,
            description: input.institution.description,
          },
          account: {
            name: input.account.name,
            typeCode: accountTypeCode,
            description: input.account.description,
          },
          holding: {
            tokenId: input.holdings[0]?.tokenId || "",
            balance: input.holdings[0]?.balance || "0",
          },
        };

        const result =
          await this.batchOperationsService.createHoldingWithDependencies(
            serviceInput,
            userId
          );

        institutionId = result.institutionId;
        accountId = result.accountId;
        createdInstitution = result.createdInstitution || false;
        createdAccount = result.createdAccount;
        firstHoldingCreated = true; // BatchOperationsService created the first holding
        firstHoldingId = result.holdingId; // Store the ID

        logger.info(
          { userId, institutionId, accountId },
          "Created institution and account"
        );
      } else {
        // Use existing institution, create account only
        institutionId = input.account.institutionId;

        logger.debug(
          { userId, institutionId },
          "Creating account with existing institution"
        );

        // Resolve account type code (convert UUID to code if needed)
        const accountTypeCode = await this.resolveAccountTypeCode(
          input.account.type
        );

        const serviceInput = {
          account: {
            institutionId,
            name: input.account.name,
            typeCode: accountTypeCode,
            description: input.account.description,
          },
          holding: {
            tokenId: input.holdings[0]?.tokenId || "",
            balance: input.holdings[0]?.balance || "0",
          },
        };

        const result =
          await this.batchOperationsService.createHoldingWithDependencies(
            serviceInput,
            userId
          );

        accountId = result.accountId;
        createdAccount = result.createdAccount;
        firstHoldingCreated = true; // BatchOperationsService created the first holding
        firstHoldingId = result.holdingId; // Store the ID

        logger.info({ userId, institutionId, accountId }, "Created account");
      }
    }

    // Step 2: Now we have accountId - create holdings
    // If we created a new account, the first holding was already created by BatchOperationsService
    const holdingsToCreate = firstHoldingCreated
      ? input.holdings.slice(1)
      : input.holdings;

    logger.info(
      {
        userId,
        accountId,
        totalHoldings: input.holdings.length,
        holdingsToCreate: holdingsToCreate.length,
        firstHoldingAlreadyCreated: firstHoldingCreated,
        holdingsToCreateDetails: holdingsToCreate.map((h) => ({
          tokenId: h.tokenId,
          balance: h.balance,
        })),
      },
      "Creating holdings for account"
    );

    const holdingsResults = [];

    // Add the first holding to results if it was created by BatchOperationsService
    if (firstHoldingCreated && input.holdings[0]) {
      holdingsResults.push({
        holdingId: firstHoldingId, // Use the actual ID from BatchOperationsService
        tokenId: input.holdings[0].tokenId || "",
        createdToken: false,
        createdHolding: true,
      });
    }

    for (const holdingInput of holdingsToCreate) {
      try {
        if (!holdingInput.tokenId) {
          throw new Error("tokenId is required for creating holding");
        }

        logger.info(
          {
            accountId,
            tokenId: holdingInput.tokenId,
            balance: holdingInput.balance,
          },
          "Creating holding"
        );

        const holdingResult = await this.createHoldingUseCase.execute(
          {
            accountId,
            tokenId: holdingInput.tokenId,
            balance: holdingInput.balance,
            lastUpdated: holdingInput.lastUpdated,
          },
          userId
        );

        logger.info(
          {
            holdingId: holdingResult.holding.id,
            tokenId: holdingInput.tokenId,
          },
          "Holding created successfully"
        );

        holdingsResults.push({
          holdingId: holdingResult.holding.id,
          tokenId: holdingInput.tokenId,
          createdToken: false,
          createdHolding: true,
        });
      } catch (error) {
        logger.error(
          { error, tokenId: holdingInput.tokenId },
          "Failed to create holding"
        );
        holdingsResults.push({
          holdingId: "",
          tokenId: holdingInput.tokenId || "",
          createdToken: false,
          createdHolding: false,
        });
      }
    }

    logger.info(
      {
        userId,
        accountId,
        institutionId,
        createdAccount,
        createdInstitution,
        holdingsCreated: holdingsResults.length,
      },
      "Completed creating holdings with dependencies"
    );

    return {
      institutionId,
      accountId,
      holdings: holdingsResults,
      createdInstitution,
      createdAccount,
    };
  }
}
