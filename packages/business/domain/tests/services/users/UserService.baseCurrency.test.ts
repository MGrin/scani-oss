import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { InvalidBaseCurrencyError, UserService } from '../../../src/services/users/UserService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import { makeToken } from '../../../test/helpers/factories-extra';

const service = () => Container.get(UserService);

async function fiatTypeId(tx: DatabaseTransaction): Promise<string> {
  const [existing] = await tx
    .select()
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await tx
    .insert(schema.tokenTypes)
    .values({ code: 'fiat', name: 'Fiat Currency' })
    .returning();
  if (!row) throw new Error('tokenTypes insert failed');
  return row.id;
}

async function baseCurrencyOf(tx: DatabaseTransaction, userId: string) {
  const [row] = await tx
    .select({ baseCurrencyId: schema.users.baseCurrencyId })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.baseCurrencyId ?? null;
}

/**
 * `users.updateCurrent` stored any token id as the base currency — a crypto
 * token, a stock, another user's private company — and every total in the app
 * is then priced in it (SC-1288). Only a fiat currency is a base currency: the
 * picker offers exactly `getSupportedCurrencies`, the active fiat tokens.
 */
describe('UserService.updateUser — base currency must be a fiat token (SC-1288)', () => {
  test('a crypto token is refused and the stored currency is unchanged', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const crypto = await makeToken(tx);

      await expect(
        service().updateUser(user.id, { baseCurrencyId: crypto.id }, tx)
      ).rejects.toBeInstanceOf(InvalidBaseCurrencyError);
      expect(await baseCurrencyOf(tx, user.id)).toBeNull();
    });
  });

  test('an id that is not a token is refused the same way', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);

      await expect(
        service().updateUser(
          user.id,
          { baseCurrencyId: '00000000-0000-4000-8000-000000000000' },
          tx
        )
      ).rejects.toBeInstanceOf(InvalidBaseCurrencyError);
    });
  });

  test('an inactive fiat token is refused — the picker does not offer it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const retired = await makeToken(tx, { typeId: await fiatTypeId(tx), isActive: false });

      await expect(
        service().updateUser(user.id, { baseCurrencyId: retired.id }, tx)
      ).rejects.toBeInstanceOf(InvalidBaseCurrencyError);
    });
  });

  test('an active fiat token is stored, and null still clears it — the control', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const fiat = await makeToken(tx, { typeId: await fiatTypeId(tx) });

      await service().updateUser(user.id, { baseCurrencyId: fiat.id }, tx);
      expect(await baseCurrencyOf(tx, user.id)).toBe(fiat.id);

      await service().updateUser(user.id, { baseCurrencyId: null }, tx);
      expect(await baseCurrencyOf(tx, user.id)).toBeNull();
    });
  });
});
