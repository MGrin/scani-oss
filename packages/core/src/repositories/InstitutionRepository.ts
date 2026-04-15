import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { Institution, NewInstitution } from '../domain/entities';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class InstitutionRepository extends BaseRepository<Institution, NewInstitution> {
  protected readonly table = schema.institutions;
  protected readonly tableName = 'institutions';

  async findByUserId(userId: string, transaction?: DatabaseTransaction): Promise<Institution[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .selectDistinct({
          institution: schema.institutions,
          type: schema.institutionTypes.code,
          typeName: schema.institutionTypes.name,
        })
        .from(schema.institutions)
        .leftJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id)
        )
        .innerJoin(schema.accounts, eq(schema.accounts.institutionId, schema.institutions.id))
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true),
            // Must match `AccountRepository.findByUser`, which excludes hidden
            // accounts — otherwise an institution whose only accounts are
            // hidden shows up on the list with an `accountCount: 0` summary,
            // because the service counts come from `findByUser` but the
            // institution visibility comes from here.
            eq(schema.accounts.isHidden, false),
            eq(schema.institutions.isActive, true)
          )
        )
        .orderBy(schema.institutions.name);

      return results.map((r) => ({
        ...r.institution,
        type: r.type,
        typeName: r.typeName,
      }));
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find institutions by user');
      throw error;
    }
  }
}
