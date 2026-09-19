import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { SaltEdgeProvider } from '@scani/providers/providers/saltedge';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { SaltEdgeConnectionService } from '../../../src/services/integrations/SaltEdgeConnectionService';
import { IntegrationCredentialsService } from '../../../src/services/users/IntegrationCredentialsService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';

restoreContainerAfterAll();

function makeService(opts: { customerId?: string; configured?: boolean } = {}) {
  const created: string[] = [];
  const stored: Record<string, unknown>[] = [];
  const provider = Object.create(SaltEdgeProvider.prototype) as SaltEdgeProvider;
  provider.createCustomer = async (identifier: string) => {
    created.push(identifier);
    return opts.customerId ?? 'cust-1';
  };
  provider.createConnectSession = async (input) => `https://connect.example/?c=${input.customerId}`;
  Container.set(ProviderRegistry, {
    getBalanceFetcher: (code: string) =>
      opts.configured === false || code !== 'saltedge' ? null : provider,
  } as unknown as ProviderRegistry);
  Container.set(IntegrationCredentialsService, {
    storeCredentials: async (_u: string, _i: string, creds: Record<string, unknown>) => {
      stored.push(creds);
      return {};
    },
  } as unknown as IntegrationCredentialsService);
  const service = new SaltEdgeConnectionService();
  return { service, created, stored };
}

describe('SaltEdgeConnectionService.ensureCustomer', () => {
  test('creates one customer per user and stores its id', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const { service, created, stored } = makeService();
      expect(await service.ensureCustomer(user.id, tx)).toBe('cust-1');
      expect(await service.ensureCustomer(user.id, tx)).toBe('cust-1');
      expect(created).toEqual([user.id]);
      expect(stored).toEqual([{ customerId: 'cust-1' }]);
    });
  });

  test('refuses when Salt Edge is not configured on this deployment', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const { service } = makeService({ configured: false });
      await expect(service.ensureCustomer(user.id, tx)).rejects.toThrow(/not configured/);
    });
  });
});

describe('SaltEdgeConnectionService.startConnect', () => {
  test("returns the widget url for the user's customer", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const { service } = makeService({ customerId: 'cust-7' });
      expect(await service.startConnect(user.id, 'https://app/return', tx)).toBe(
        'https://connect.example/?c=cust-7'
      );
    });
  });
});

describe('SaltEdgeConnectionService.applyCallback', () => {
  async function seed(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    const user = await makeUser(tx);
    await tx.insert(schema.saltedgeCustomers).values({ userId: user.id, customerId: 'cust-1' });
    return user;
  }
  const row = async (tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) =>
    (
      await tx
        .select()
        .from(schema.saltedgeConnections)
        .where(eq(schema.saltedgeConnections.connectionId, 'conn-1'))
    )[0];

  test('success records an active connection and asks for an import', async () => {
    await withTestDb(async (tx) => {
      const user = await seed(tx);
      const { service } = makeService();
      const outcome = await service.applyCallback(
        'success',
        { connectionId: 'conn-1', customerId: 'cust-1' },
        tx
      );
      expect(outcome).toEqual({ kind: 'applied', userId: user.id, importNeeded: true });
      expect((await row(tx))?.status).toBe('active');
    });
  });

  test('fail records the error class and asks for nothing', async () => {
    await withTestDb(async (tx) => {
      await seed(tx);
      const { service } = makeService();
      const outcome = await service.applyCallback(
        'fail',
        { connectionId: 'conn-1', customerId: 'cust-1', errorClass: 'InvalidCredentials' },
        tx
      );
      expect(outcome).toMatchObject({ kind: 'applied', importNeeded: false });
      expect(await row(tx)).toMatchObject({ status: 'failed', lastError: 'InvalidCredentials' });
    });
  });

  test('an expired consent makes an active connection inactive', async () => {
    await withTestDb(async (tx) => {
      await seed(tx);
      const { service } = makeService();
      await service.applyCallback('success', { connectionId: 'conn-1', customerId: 'cust-1' }, tx);
      await service.applyCallback(
        'consent',
        { connectionId: 'conn-1', customerId: 'cust-1', errorClass: 'expired' },
        tx
      );
      expect(await row(tx)).toMatchObject({ status: 'inactive', lastError: 'expired' });
    });
  });

  test('destroy removes the connection', async () => {
    await withTestDb(async (tx) => {
      await seed(tx);
      const { service } = makeService();
      await service.applyCallback('success', { connectionId: 'conn-1', customerId: 'cust-1' }, tx);
      await service.applyCallback('destroy', { connectionId: 'conn-1', customerId: 'cust-1' }, tx);
      expect(await row(tx)).toBeUndefined();
    });
  });

  test('an unknown customer is ignored, not attributed to anyone', async () => {
    await withTestDb(async (tx) => {
      await seed(tx);
      const { service } = makeService();
      const outcome = await service.applyCallback(
        'success',
        { connectionId: 'conn-1', customerId: 'someone-else' },
        tx
      );
      expect(outcome).toEqual({ kind: 'ignored', reason: 'unknown-customer' });
      expect(await row(tx)).toBeUndefined();
    });
  });
});
