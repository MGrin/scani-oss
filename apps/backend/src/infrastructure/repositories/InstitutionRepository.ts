import { and, eq, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import type { Account, Institution, NewInstitution } from '../../domain/entities';
import type {
  DatabaseTransaction,
  IInstitutionRepository,
} from '../../domain/interfaces/repositories';
import * as schema from '../database/schema';
import { BaseRepository } from './BaseRepository';

@Service()
export class InstitutionRepository
  extends BaseRepository<Institution, NewInstitution>
  implements IInstitutionRepository
{
  protected readonly table = schema.institutions;
  protected readonly tableName = 'institutions';

  async findAll(
    filters?: Record<string, unknown>,
    transaction?: DatabaseTransaction
  ): Promise<Institution[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          institution: schema.institutions,
          type: schema.institutionTypes.code,
          typeName: schema.institutionTypes.name,
        })
        .from(schema.institutions)
        .leftJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id)
        )
        .where(eq(schema.institutions.isActive, true))
        .orderBy(schema.institutions.name);

      return results.map((result) => ({
        ...result.institution,
        type: result.type,
        typeName: result.typeName,
      }));
    } catch (error) {
      this.logger.error({ filters, error }, 'Failed to find all institutions');
      throw error;
    }
  }

  async findByName(name: string, transaction?: DatabaseTransaction): Promise<Institution | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.institutions)
        .where(sql`LOWER(${schema.institutions.name}) = ${name.toLowerCase()}`)
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ name, error }, 'Failed to find institution by name');
      throw error;
    }
  }

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

  async findWithType(
    institutionId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Institution & { typeCode: string | null }) | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          id: schema.institutions.id,
          name: schema.institutions.name,
          typeId: schema.institutions.typeId,
          description: schema.institutions.description,
          website: schema.institutions.website,
          logoUrl: schema.institutions.logoUrl,
          isActive: schema.institutions.isActive,
          createdAt: schema.institutions.createdAt,
          updatedAt: schema.institutions.updatedAt,
          typeCode: schema.institutionTypes.code,
        })
        .from(schema.institutions)
        .leftJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id)
        )
        .where(eq(schema.institutions.id, institutionId))
        .limit(1);

      return (results[0] as Institution & { typeCode: string | null }) || null;
    } catch (error) {
      this.logger.error({ institutionId, error }, 'Failed to find institution with type');
      throw error;
    }
  }

  async findWithAccounts(
    institutionId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Institution & { accounts: Account[] }) | null> {
    try {
      const database = this.getDb(transaction);

      // Get institution
      const institution = await this.findById(institutionId, transaction);
      if (!institution) return null;

      // Get accounts for this institution and user
      const accounts = await database
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.institutionId, institutionId),
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true)
          )
        );

      return {
        ...institution,
        accounts,
      };
    } catch (error) {
      this.logger.error(
        { institutionId, userId, error },
        'Failed to find institution with accounts'
      );
      throw error;
    }
  }

  async findByNameAndType(
    name: string,
    typeId: string,
    transaction?: DatabaseTransaction
  ): Promise<Institution | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.institutions)
        .where(
          and(
            sql`LOWER(${schema.institutions.name}) = ${name.toLowerCase()}`,
            eq(schema.institutions.typeId, typeId)
          )
        )
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ name, typeId, error }, 'Failed to find institution by name and type');
      throw error;
    }
  }
}
