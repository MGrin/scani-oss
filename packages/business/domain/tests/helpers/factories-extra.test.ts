import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';
import { makeToken } from '../../test/helpers/factories-extra';

async function typeCodeOf(tx: DatabaseTransaction, typeId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ code: schema.tokenTypes.code })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.id, typeId))
    .limit(1);
  return row?.code;
}

/**
 * SC-967. `makeToken`'s default type came from `select … limit 1` over a
 * `token_types` table the migrations seed with five rows, fiat first, so a
 * helper named for crypto handed every caller a fiat token.
 */
describe('makeToken default token type', () => {
  test('with no typeId the token is crypto on a migrated database', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx);
      expect(await typeCodeOf(tx, token.typeId)).toBe('crypto');
    });
  });

  test('an explicit fiat typeId still gives fiat', async () => {
    await withTestDb(async (tx) => {
      const [fiat] = await tx
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, 'fiat'))
        .limit(1);
      if (!fiat) throw new Error('migrated database has no fiat token type');
      const token = await makeToken(tx, { typeId: fiat.id });
      expect(await typeCodeOf(tx, token.typeId)).toBe('fiat');
    });
  });
});
