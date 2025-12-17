/**
 * CreatePlaidLinkTokenUseCase
 *
 * Creates a Plaid Link token for frontend integration
 * This token is used by the Plaid Link component to initiate the OAuth flow
 */

import { createPlaidLinkToken } from '@scani/integrations';
import { Service } from 'typedi';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:create-plaid-link-token');

export interface CreatePlaidLinkTokenInput {
  /** User ID */
  userId: string;
  /** Optional Plaid institution ID to pre-select */
  plaidInstitutionId?: string;
}

export interface CreatePlaidLinkTokenResult {
  /** Link token for frontend */
  linkToken: string;
  /** Token expiration time */
  expiration: string;
}

/**
 * Create Plaid Link Token Use Case
 */
@Service()
export class CreatePlaidLinkTokenUseCase {
  async execute(input: CreatePlaidLinkTokenInput): Promise<CreatePlaidLinkTokenResult> {
    logger.info({ userId: input.userId }, 'Creating Plaid Link token');

    try {
      const result = await createPlaidLinkToken(input.userId, input.plaidInstitutionId);

      logger.info({ userId: input.userId }, 'Plaid Link token created successfully');

      return result;
    } catch (error) {
      logger.error({ userId: input.userId, error }, 'Failed to create Plaid Link token');
      throw error;
    }
  }
}
