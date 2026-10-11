import type { DatabaseTransaction } from '@scani/db';
import { getDb } from '@scani/db/connection';
import type { AccountWrapper } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { asc, eq } from 'drizzle-orm';
import { Service } from 'typedi';

/** SC-1645: the seeded wrapper lookup. Reference data; it changes only by migration. */
@Service()
export class AccountWrapperRepository {
  async list(tx?: DatabaseTransaction): Promise<AccountWrapper[]> {
    return (tx ?? getDb())
      .select()
      .from(schema.accountWrappers)
      .orderBy(asc(schema.accountWrappers.displayOrder));
  }

  async findByCode(code: string, tx?: DatabaseTransaction): Promise<AccountWrapper | null> {
    const [row] = await (tx ?? getDb())
      .select()
      .from(schema.accountWrappers)
      .where(eq(schema.accountWrappers.code, code))
      .limit(1);
    return row ?? null;
  }
}
