import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { EXCHANGE_IMPORT } from '@scani/jobs';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { IbkrProvider } from '@scani/providers/providers/ibkr';
import { BullMqEnqueueService } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1534: removing the last account at an institution disconnects its
// credential, and connecting again failed — the row was still there, inactive,
// and the connect inserted beside it into the (user, institution) key.
// Interactive Brokers, because its keys are checked by the worker and not here.

restoreContainerAfterAll();

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let user: User;
let institutionId: string;
let accountTypeId: string;
const imports: string[] = [];

const connect = () =>
  makeAuthedCaller(user).integrations.validateKeys({
    providerKey: 'ibkr',
    credentials: { flexQueryToken: `token-${randomUUID()}`, flexQueryId: 'query-1' },
    requestId: randomUUID(),
  });

const stored = () =>
  db
    .select()
    .from(schema.userIntegrationCredentials)
    .where(eq(schema.userIntegrationCredentials.userId, user.id));

beforeAll(async () => {
  // What boot does for every provider: the route reads the manifest from the
  // registry. The limiter is never reached, since this connect calls nothing.
  const registry = new ProviderRegistry();
  registry.register(new IbkrProvider({} as never));
  Container.set(ProviderRegistry, registry);
  // Removing an account enqueues work of its own, so only imports are counted.
  Container.set(BullMqEnqueueService, {
    async add(descriptor: unknown) {
      const jobId = `job-${randomUUID()}`;
      if (descriptor === EXCHANGE_IMPORT) imports.push(jobId);
      return jobId;
    },
  } as unknown as BullMqEnqueueService);

  const [created] = await db
    .insert(schema.users)
    .values({ email: `sc1534-${suffix}@scani.local`, name: 'SC-1534' })
    .returning();
  user = created!;
  const [institution] = await db
    .select()
    .from(schema.institutions)
    .where(eq(schema.institutions.name, 'Interactive Brokers'));
  if (!institution) throw new Error('the migrations seed Interactive Brokers');
  institutionId = institution.id;
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `sc1534-acct-${suffix}`, name: 'SC-1534 account type' })
    .returning();
  accountTypeId = accountType!.id;
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
});

describe('integrations.validateKeys after a disconnect (SC-1534)', () => {
  test('connect, remove the last account, connect again: the same credential, active, with a new import', async () => {
    const first = await connect();
    const [connected] = await stored();
    expect([connected?.isActive, connected?.importStatus, connected?.importJobId]).toEqual([
      true,
      'enqueued',
      first.jobId,
    ]);

    const [account] = await db
      .insert(schema.accounts)
      .values({ userId: user.id, institutionId, name: `SC-1534 ${suffix}`, typeId: accountTypeId })
      .returning();
    await makeAuthedCaller(user).accounts.delete({ id: account!.id });
    expect((await stored()).map((c) => [c.id, c.isActive])).toEqual([[connected!.id, false]]);

    const second = await connect();

    expect(second.success).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);
    expect(imports).toEqual([first.jobId, second.jobId]);
    expect((await stored()).map((c) => [c.id, c.isActive, c.importStatus, c.importJobId])).toEqual([
      [connected!.id, true, 'enqueued', second.jobId],
    ]);
  });
});
