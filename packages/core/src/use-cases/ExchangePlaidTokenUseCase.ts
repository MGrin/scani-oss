/**
 * ExchangePlaidTokenUseCase
 *
 * Exchanges a Plaid public token for an access token and stores it
 * Also handles institution upsert/mapping logic
 */

import { exchangePlaidPublicToken, getPlaidInstitution } from '@scani/integrations';
import { eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import type { IntegrationCredentialsService } from '../services/IntegrationCredentialsService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:exchange-plaid-token');

export interface ExchangePlaidTokenInput {
  /** User ID */
  userId: string;
  /** Public token from Plaid Link */
  publicToken: string;
  /** Plaid institution ID */
  plaidInstitutionId: string;
  /** Institution name from Plaid metadata */
  institutionName?: string;
}

export interface ExchangePlaidTokenResult {
  /** Plaid item ID */
  plaidItemId: string;
  /** Scani institution ID (created or existing) */
  institutionId: string;
  /** Whether institution was created */
  institutionCreated: boolean;
}

/**
 * Exchange Plaid Token Use Case
 */
@Service()
export class ExchangePlaidTokenUseCase {
  constructor(private readonly integrationCredentialsService: IntegrationCredentialsService) {}

  async execute(input: ExchangePlaidTokenInput): Promise<ExchangePlaidTokenResult> {
    logger.info(
      { userId: input.userId, plaidInstitutionId: input.plaidInstitutionId },
      'Exchanging Plaid public token'
    );

    try {
      // Exchange public token for access token
      const { accessToken, itemId } = await exchangePlaidPublicToken(input.publicToken);

      logger.info({ userId: input.userId, itemId }, 'Token exchanged successfully');

      // Get or create institution
      const { institutionId, created } = await this.getOrCreateInstitution(
        input.plaidInstitutionId,
        input.institutionName
      );

      logger.info(
        { institutionId, created },
        created ? 'Institution created' : 'Institution found'
      );

      // Create or update Plaid item record
      await this.createOrUpdatePlaidItem({
        userId: input.userId,
        institutionId,
        plaidItemId: itemId,
        plaidAccessToken: accessToken,
        plaidInstitutionId: input.plaidInstitutionId,
      });

      // Store credentials
      await this.integrationCredentialsService.storeCredentials(
        input.userId,
        institutionId,
        {
          accessToken,
          itemId,
        },
        'oauth' // Plaid uses OAuth-like flow
      );

      logger.info(
        { userId: input.userId, institutionId },
        'Plaid integration completed successfully'
      );

      return {
        plaidItemId: itemId,
        institutionId,
        institutionCreated: created,
      };
    } catch (error) {
      logger.error({ userId: input.userId, error }, 'Failed to exchange Plaid token');
      throw error;
    }
  }

  /**
   * Get existing institution by Plaid mapping or create new one
   */
  private async getOrCreateInstitution(
    plaidInstitutionId: string,
    institutionName?: string
  ): Promise<{ institutionId: string; created: boolean }> {
    // Check if institution already mapped to Plaid
    const [existingMapping] = await db
      .select()
      .from(schema.institutionPlaidMappings)
      .where(eq(schema.institutionPlaidMappings.plaidInstitutionId, plaidInstitutionId))
      .limit(1);

    if (existingMapping) {
      return {
        institutionId: existingMapping.institutionId,
        created: false,
      };
    }

    // Fetch institution details from Plaid if name not provided
    let name = institutionName;
    let url: string | null = null;
    let logoUrl: string | null = null;

    if (!name) {
      try {
        const plaidInstitution = await getPlaidInstitution(plaidInstitutionId);
        name = plaidInstitution.name;
        url = plaidInstitution.url;
        logoUrl = plaidInstitution.logo;
      } catch (error) {
        logger.warn(
          { plaidInstitutionId, error },
          'Failed to fetch Plaid institution details, using fallback'
        );
        name = 'Unknown Bank';
      }
    }

    // Get bank institution type
    const [bankType] = await db
      .select()
      .from(schema.institutionTypes)
      .where(eq(schema.institutionTypes.code, 'bank'))
      .limit(1);

    if (!bankType) {
      throw new Error('Bank institution type not found in database');
    }

    // Create new institution
    const [newInstitution] = await db
      .insert(schema.institutions)
      .values({
        name,
        typeId: bankType.id,
        website: url,
        logoUrl,
        hasIntegration: true, // Plaid institutions have integration support
        isActive: true,
      })
      .returning();

    if (!newInstitution) {
      throw new Error('Failed to create institution');
    }

    // Create mapping
    await db.insert(schema.institutionPlaidMappings).values({
      institutionId: newInstitution.id,
      plaidInstitutionId,
      isActive: true,
    });

    logger.info(
      { institutionId: newInstitution.id, plaidInstitutionId },
      'Created new institution with Plaid mapping'
    );

    return {
      institutionId: newInstitution.id,
      created: true,
    };
  }

  /**
   * Create or update Plaid item record
   */
  private async createOrUpdatePlaidItem(data: {
    userId: string;
    institutionId: string;
    plaidItemId: string;
    plaidAccessToken: string;
    plaidInstitutionId: string;
  }): Promise<void> {
    // Check if item already exists
    const [existingItem] = await db
      .select()
      .from(schema.plaidItems)
      .where(eq(schema.plaidItems.plaidItemId, data.plaidItemId))
      .limit(1);

    if (existingItem) {
      // Update existing item
      await db
        .update(schema.plaidItems)
        .set({
          plaidAccessToken: data.plaidAccessToken,
          isActive: true,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.plaidItems.id, existingItem.id));

      logger.info({ plaidItemId: data.plaidItemId }, 'Updated existing Plaid item');
    } else {
      // Create new item
      await db.insert(schema.plaidItems).values({
        userId: data.userId,
        institutionId: data.institutionId,
        plaidItemId: data.plaidItemId,
        plaidAccessToken: data.plaidAccessToken,
        plaidInstitutionId: data.plaidInstitutionId,
        isActive: true,
      });

      logger.info({ plaidItemId: data.plaidItemId }, 'Created new Plaid item');
    }
  }
}
