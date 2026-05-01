import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type {
  InstitutionBlockchainMapping,
  NewInstitutionBlockchainMapping,
} from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Service } from 'typedi';

@Service()
export class InstitutionBlockchainMappingRepository extends BaseRepository<
  InstitutionBlockchainMapping,
  NewInstitutionBlockchainMapping
> {
  protected readonly table = schema.institutionBlockchainMappings;
  protected readonly tableName = 'institution_blockchain_mappings';

  /**
   * Find mapping by institution ID
   */
  async findByInstitutionId(
    institutionId: string,
    transaction?: DatabaseTransaction
  ): Promise<InstitutionBlockchainMapping | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(this.table)
        .where(eq(this.table.institutionId, institutionId))
        .limit(1);

      return (results[0] as InstitutionBlockchainMapping) || null;
    } catch (error) {
      this.logger.error({ institutionId, error }, 'Failed to find mapping by institution ID');
      throw error;
    }
  }

  /**
   * Find mapping by chain ID
   */
  async findByChainId(
    chainId: string,
    transaction?: DatabaseTransaction
  ): Promise<InstitutionBlockchainMapping | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(this.table)
        .where(eq(this.table.chainId, chainId))
        .limit(1);

      return (results[0] as InstitutionBlockchainMapping) || null;
    } catch (error) {
      this.logger.error({ chainId, error }, 'Failed to find mapping by chain ID');
      throw error;
    }
  }

  /**
   * Find all active mappings
   */
  async findAllActive(transaction?: DatabaseTransaction): Promise<InstitutionBlockchainMapping[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database.select().from(this.table).where(eq(this.table.isActive, true));

      return results as InstitutionBlockchainMapping[];
    } catch (error) {
      this.logger.error({ error }, 'Failed to find all active mappings');
      throw error;
    }
  }
}
