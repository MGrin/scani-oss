import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cloudApiKeys, users } from '@scani/db';
import { eq } from 'drizzle-orm';
import type { DataProviderEnv } from '../../../src/config/env';
import { getCloudDb } from '../../../src/db/connection';
import { installCloudDb, keysRouter } from '../../../src/presentation/routers/keys';
import { buildCreateContext, type DataProviderContext } from '../../../src/presentation/trpc';
import { buildAuthedContext, withCloudUser } from '../../helpers/test-context';

// The status a new key starts in is the deployment's choice. A self-hoster
// never sets it and gets a working key; a deployment that decides access
// elsewhere starts keys suspended and lets that decision open them.

const db = getCloudDb(process.env.DATABASE_URL as string);
let owner: string;

const callerWith = (overrides: Partial<DataProviderContext> = {}) =>
  keysRouter.createCaller({
    ...buildAuthedContext(),
    ...withCloudUser({ id: owner, email: `${owner}@example.com`, name: null }),
    ...overrides,
  });

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: cloudApiKeys.billingStatus })
    .from(cloudApiKeys)
    .where(eq(cloudApiKeys.id, id));
  return row?.status;
}

beforeAll(async () => {
  installCloudDb(db);
  const [row] = await db
    .insert(users)
    .values({ email: `initial-status-${randomUUID().slice(0, 8)}@example.com`, name: 'o' })
    .returning();
  owner = row!.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  installCloudDb(null);
});

describe('keys.create — the initial status', () => {
  test('the self-host default is active', async () => {
    const created = await callerWith().create({ name: 'default' });
    expect(await statusOf(created.id)).toBe('active');
  });

  test('a deployment that starts keys suspended gets a suspended key', async () => {
    const created = await callerWith({ initialKeyStatus: 'suspended' }).create({ name: 'held' });
    expect(await statusOf(created.id)).toBe('suspended');
  });
});

describe('CLOUD_KEY_INITIAL_STATUS reaches the context', () => {
  const build = (value: 'active' | 'suspended') =>
    buildCreateContext({
      env: {
        CLOUD_QUOTA_HOURLY_DEFAULT: null,
        CLOUD_KEY_INITIAL_STATUS: value,
      } as DataProviderEnv,
      getCloudDb: () => null,
      appSession: null,
    })({ req: new Request('http://localhost/trpc') });

  test.each(['active', 'suspended'] as const)('%s', async (value) => {
    expect((await build(value)).initialKeyStatus).toBe(value);
  });
});
