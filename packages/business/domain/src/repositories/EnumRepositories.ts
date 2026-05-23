import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { AccountType, InstitutionType, TokenType } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Service } from 'typedi';

// Enum-table TTL. These tables (institution_types, account_types, token_types)
// only change via migrations, so a 10-minute cache is safe in a running
// process — a deploy/restart flushes it. Kept per-repo-instance (one
// singleton via TypeDI) so there's no global map to reason about.
const ENUM_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

@Service()
export class InstitutionTypeRepository extends BaseRepository<
  InstitutionType,
  Partial<InstitutionType>
> {
  protected readonly table = schema.institutionTypes;
  protected readonly tableName = 'institution_types';
  private readonly cache = new TtlCache<InstitutionType | null>();

  async findByCode(
    code: string,
    transaction?: DatabaseTransaction
  ): Promise<InstitutionType | null> {
    // Skip cache if called from inside a transaction — consumers inside a tx
    // expect fresh reads to observe their own writes (e.g. after a seed).
    if (!transaction) {
      const cached = this.cache.get(code);
      if (cached !== undefined) return cached;
    }
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.institutionTypes)
        .where(eq(schema.institutionTypes.code, code))
        .limit(1);

      const value = results[0] || null;
      if (!transaction) this.cache.set(code, value, ENUM_CACHE_TTL_MS);
      return value;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find institution type by code');
      throw error;
    }
  }
}

@Service()
export class AccountTypeRepository extends BaseRepository<AccountType, Partial<AccountType>> {
  protected readonly table = schema.accountTypes;
  protected readonly tableName = 'account_types';
  private readonly cache = new TtlCache<AccountType | null>();

  async findByCode(code: string, transaction?: DatabaseTransaction): Promise<AccountType | null> {
    if (!transaction) {
      const cached = this.cache.get(code);
      if (cached !== undefined) return cached;
    }
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.code, code))
        .limit(1);

      const value = results[0] || null;
      if (!transaction) this.cache.set(code, value, ENUM_CACHE_TTL_MS);
      return value;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find account type by code');
      throw error;
    }
  }
}

@Service()
export class TokenTypeRepository extends BaseRepository<TokenType, Partial<TokenType>> {
  protected readonly table = schema.tokenTypes;
  protected readonly tableName = 'token_types';
  private readonly cache = new TtlCache<TokenType | null>();

  async findByCode(code: string, transaction?: DatabaseTransaction): Promise<TokenType | null> {
    if (!transaction) {
      const cached = this.cache.get(code);
      if (cached !== undefined) return cached;
    }
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, code))
        .limit(1);

      const value = results[0] || null;
      if (!transaction) this.cache.set(code, value, ENUM_CACHE_TTL_MS);
      return value;
    } catch (error) {
      this.logger.error({ code, error }, 'Failed to find token type by code');
      throw error;
    }
  }

  /**
   * Find multiple token types by their codes
   */
  async findByCodes(codes: string[], transaction?: DatabaseTransaction): Promise<TokenType[]> {
    try {
      if (codes.length === 0) {
        return [];
      }

      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenTypes)
        .where(inArray(schema.tokenTypes.code, codes));

      return results;
    } catch (error) {
      this.logger.error({ codes, error }, 'Failed to find token types by codes');
      throw error;
    }
  }
}
