/**
 * R95. `holdings.refreshBalance` refuses on the same answer the holdings list
 * ships as `refreshable`: a feed states the balance, and a live wallet or
 * credential is there to ask. The refusal says which of the two is missing,
 * because "this holding is manual" sends a person whose exchange was
 * disconnected to edit a number the exchange would have corrected. A feed with
 * nothing live to ask gets one sentence whether a connection was removed or
 * never existed (R96), so it says connect, not reconnect. A person's row an
 * import wrote into keeps the manual sentence: the sync never writes that row,
 * so a refresh would leave it as it stands (R97).
 *
 * The rows are committed: the router reads through the process-wide handle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  makeAccount,
  makeCredential,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { REFRESH_ACCOUNT_BALANCE } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;
type Holding = typeof schema.holdings.$inferSelect;

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

let user: User;
let tokenId: string;
const institutionIds: string[] = [];
const enqueued: Array<{ job: unknown; payload: unknown }> = [];

/** One holding in an account of its own, at an exchange of its own. */
async function holdingAt(
  credential: 'live' | 'removed' | 'none',
  holding: Pick<Holding, 'source' | 'kind'>
): Promise<Holding> {
  const type = await makeInstitutionType(db, { code: 'crypto_exchange' });
  const institution = await makeInstitution(db, { typeId: type.id });
  institutionIds.push(institution.id);
  const at = { userId: user.id, institutionId: institution.id };
  if (credential !== 'none') await makeCredential(db, { ...at, isActive: credential === 'live' });
  const account = await makeAccount(db, at);
  return makeHolding(db, { userId: user.id, accountId: account.id, tokenId, ...holding });
}

const refresh = (holding: Holding) =>
  makeAuthedCaller(user).holdings.refreshBalance({ holdingId: holding.id, requestId: REQUEST_ID });

beforeAll(async () => {
  user = await makeUser(db);
  tokenId = (await makeToken(db)).id;
  Container.set(BullMqEnqueueService, {
    add: async (job: unknown, payload: unknown) => {
      enqueued.push({ job, payload });
      return 'job-1';
    },
  } as unknown as BullMqEnqueueService);
});

beforeEach(() => {
  enqueued.length = 0;
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, tokenId));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
});

describe('holdings.refreshBalance refuses on kind and the live sync (R95)', () => {
  test.each<[string, 'removed' | 'none', Pick<Holding, 'source' | 'kind'>]>([
    [
      'F2: a statement-fed holding in an account that never had a connection',
      'none',
      { source: 'statement-import', kind: 'feed' },
    ],
    [
      'F3: a feed holding whose credential was removed',
      'removed',
      { source: 'sync_exchange_balances', kind: 'feed' },
    ],
  ])(
    '%s is told there is no active connection, and to connect or re-authorise',
    async (_name, credential, shape) => {
      const holding = await holdingAt(credential, shape);

      const refusal = await refresh(holding).then(
        () => null,
        (error: { code: string; message: string }) => error
      );

      expect(refusal?.code).toBe('PRECONDITION_FAILED');
      expect(refusal?.message).toBe(
        'There is no active connection to refresh this holding from — connect or re-authorise the integration.'
      );
      // The client shows a server sentence only when it is one short line.
      expect(refusal?.message.length).toBeLessThanOrEqual(200);
      expect(refusal?.message).not.toContain('\n');
      expect(enqueued).toEqual([]);
    }
  );

  test.each<[string, 'live' | 'none', Pick<Holding, 'source' | 'kind'>]>([
    ["a person's snapshot", 'none', { source: 'manual', kind: 'snapshot' }],
    [
      "F1 (R97): a person's row an import wrote into, credential live",
      'live',
      { source: 'manual', kind: 'feed' },
    ],
  ])('%s keeps the manual wording', async (_name, credential, shape) => {
    const holding = await holdingAt(credential, shape);

    await expect(refresh(holding)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        'This holding is manual — edit the balance directly. Refresh is only for wallet / exchange / broker holdings.',
    });
    expect(enqueued).toEqual([]);
  });

  test('control: a synced feed holding, credential live, is refreshed', async () => {
    const holding = await holdingAt('live', { source: 'sync_exchange_balances', kind: 'feed' });

    expect(await refresh(holding)).toEqual({ jobId: 'job-1' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.job).toBe(REFRESH_ACCOUNT_BALANCE);
    expect(enqueued[0]?.payload).toEqual({
      userId: user.id,
      requestId: REQUEST_ID,
      holdingId: holding.id,
      accountId: holding.accountId,
    });
  });
});
