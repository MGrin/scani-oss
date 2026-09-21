/**
 * SC-1271. A burn address is refused at the router, before anything is
 * enqueued; a real address still reaches the queue.
 */
import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const enqueued: unknown[] = [];
Container.set(BullMqEnqueueService, {
  add: async (_descriptor: unknown, data: unknown) => {
    enqueued.push(data);
    return 'job-1';
  },
} as unknown as BullMqEnqueueService);

const caller = makeAuthedCaller({
  id: crypto.randomUUID(),
  email: 'burn@scani.local',
  name: 'Burn Test',
  baseCurrencyId: null,
  image: null,
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} as typeof schema.users.$inferSelect);

describe('wallet.importAddress refuses a burn address (SC-1271)', () => {
  test('the zero address is BAD_REQUEST and nothing is enqueued', async () => {
    await expect(
      caller.wallet.importAddress({
        address: '0x0000000000000000000000000000000000000000',
        requestId: crypto.randomUUID(),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(enqueued).toEqual([]);
  });

  test('a real address is still enqueued', async () => {
    const out = await caller.wallet.importAddress({
      address: '0xabcdef0000000000000000000000000000000000',
      requestId: crypto.randomUUID(),
    });
    expect(out).toEqual({ jobId: 'job-1' });
    expect(enqueued).toHaveLength(1);
  });
});
