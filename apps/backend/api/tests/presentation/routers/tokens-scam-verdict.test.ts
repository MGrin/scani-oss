import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { UserTokenScamVerdictRepository } from '@scani/domain/repositories';
import { PortfolioValueCache, TokenService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1160: `markAsScam` / `unmarkAsScam` record the CALLER's verdict and
// nothing else. `unmarkAsScam` used to write the shared `tokens` row, which the
// rescorer never recomputes — so one user's click un-flagged a token for every
// user, for good. The repository test proves a verdict stays with its user;
// this proves the router writes one, for the caller, rather than the row.

restoreContainerAfterAll();

const TOKEN_ID = '00000000-0000-4000-8000-000000000001';

function fakeUser(id: string): typeof schema.users.$inferSelect {
  return { id, email: `${id}@scani.local` } as typeof schema.users.$inferSelect;
}

function stubAll() {
  const writes: Array<[string, string, string]> = [];
  Container.set(UserTokenScamVerdictRepository, {
    setVerdict: async (userId: string, tokenId: string, verdict: string) => {
      writes.push([userId, tokenId, verdict]);
    },
  } as unknown as UserTokenScamVerdictRepository);
  Container.set(TokenService, {
    getTokenById: async (id: string) => ({ id, symbol: 'ZZZ' }),
  } as unknown as TokenService);
  Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);
  Container.set(BullMqEnqueueService, { add: async () => {} } as unknown as BullMqEnqueueService);
  Container.set(RedisRealtimeUpdatesService, {
    broadcast: () => {},
  } as unknown as RedisRealtimeUpdatesService);
  return writes;
}

describe('tokens scam verdict procedures (SC-1160)', () => {
  test('unmarkAsScam records not_scam for the caller', async () => {
    const writes = stubAll();
    const result = await makeAuthedCaller(fakeUser('user-a')).tokens.unmarkAsScam({
      tokenId: TOKEN_ID,
    });
    expect(result).toEqual({ success: true, tokenId: TOKEN_ID });
    expect(writes).toEqual([['user-a', TOKEN_ID, 'not_scam']]);
  });

  test('markAsScam records scam for the caller, and a second caller writes their own', async () => {
    const writes = stubAll();
    await makeAuthedCaller(fakeUser('user-a')).tokens.markAsScam({ tokenId: TOKEN_ID });
    await makeAuthedCaller(fakeUser('user-b')).tokens.unmarkAsScam({ tokenId: TOKEN_ID });
    expect(writes).toEqual([
      ['user-a', TOKEN_ID, 'scam'],
      ['user-b', TOKEN_ID, 'not_scam'],
    ]);
  });
});
