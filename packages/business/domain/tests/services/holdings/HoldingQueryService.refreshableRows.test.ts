import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { Container } from 'typedi';
import {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  MANUAL_HOLDING_SOURCE,
} from '../../../src/services/holdings/balance-sync-sources';
import { HoldingQueryService } from '../../../src/services/holdings/HoldingQueryService';
import { committedRows } from '../../../test/helpers/committed-rows';
import {
  makeCredential,
  makeInstitution,
  makeInstitutionType,
  makeUser,
} from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

/**
 * R97 (m5). The real list over real rows, with nothing stubbed: the row the
 * repository returns carries the columns the answer reads, and the answer
 * reaches the wire. `HoldingQueryService.refreshable.test.ts` stubs both ends
 * and holds only what is asked and what is shipped.
 *
 * The list takes no transaction, so the rows are committed and dropped.
 */

const rows = committedRows();
afterEach(rows.drop);

describe('HoldingQueryService: refreshable, from the stored rows', () => {
  test("a person's row an import wrote into (F1) and a feed whose credential was removed (F3) are not refreshable, and a synced feed is", async () => {
    const seeded = await getDb().transaction(async (tx) => {
      const [base, held] = [await makeToken(tx), await makeToken(tx)];
      rows.tokens.push(base.id, held.id);
      const user = await makeUser(tx, { baseCurrencyId: base.id });
      rows.users.push(user.id);
      const exchange = await makeInstitutionType(tx, { code: 'crypto_exchange' });

      /** One holding in an account of its own, at an exchange of its own. */
      const holdingAt = async (
        credential: 'live' | 'removed',
        shape: Pick<Holding, 'source' | 'kind'>
      ): Promise<Holding> => {
        const institution = await makeInstitution(tx, { typeId: exchange.id });
        rows.institutions.push(institution.id);
        const at = { userId: user.id, institutionId: institution.id };
        await makeCredential(tx, { ...at, isActive: credential === 'live' });
        const account = await makeAccount(tx, at);
        return makeHolding(tx, { ...at, accountId: account.id, tokenId: held.id, ...shape });
      };

      return {
        user,
        f1: await holdingAt('live', { source: MANUAL_HOLDING_SOURCE, kind: 'feed' }),
        f3: await holdingAt('removed', { source: EXCHANGE_BALANCE_SYNC_SOURCE, kind: 'feed' }),
        control: await holdingAt('live', { source: EXCHANGE_BALANCE_SYNC_SOURCE, kind: 'feed' }),
      };
    });

    const listed = await Container.get(HoldingQueryService).getHoldingsByAccountIdWithDetails(
      seeded.user
    );

    const refreshable = new Map(listed.map((holding) => [holding.id, holding.refreshable]));
    expect(
      [seeded.f1, seeded.f3, seeded.control].map((holding) => refreshable.get(holding.id))
    ).toEqual([false, false, true]);
  });
});
