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
  const reconnects: { connectionId: string; returnTo: string }[] = [];
  provider.createReconnectSession = async (input) => {
    reconnects.push({ connectionId: input.connectionId, returnTo: input.returnTo });
    return `https://connect.example/?r=${input.connectionId}`;
  };
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
  return { service, created, stored, reconnects };
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

describe('SaltEdgeConnectionService — reconnecting a bank', () => {
  type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];
  async function link(
    tx: Tx,
    userId: string,
    customerId: string,
    connectionId: string,
    status: string
  ) {
    await tx.insert(schema.saltedgeCustomers).values({ userId, customerId }).onConflictDoNothing();
    await tx.insert(schema.saltedgeConnections).values({
      userId,
      customerId,
      connectionId,
      status,
      lastError: status === 'active' ? null : 'expired',
    });
  }

  test("lists only the user's own banks, and says which need reconnecting", async () => {
    await withTestDb(async (tx) => {
      const me = await makeUser(tx);
      const other = await makeUser(tx);
      await link(tx, me.id, 'cust-me', 'conn-ok', 'active');
      await link(tx, me.id, 'cust-me', 'conn-expired', 'inactive');
      await link(tx, me.id, 'cust-me', 'conn-failed', 'failed');
      await link(tx, other.id, 'cust-other', 'conn-theirs', 'inactive');
      const { service } = makeService();
      const rows = await service.listConnections(me.id, tx);
      expect(rows.map((r) => [r.connectionId, r.needsReconnect]).sort()).toEqual([
        ['conn-expired', true],
        ['conn-failed', true],
        ['conn-ok', false],
      ]);
    });
  });

  test('reconnect opens a widget session on that connection', async () => {
    await withTestDb(async (tx) => {
      const me = await makeUser(tx);
      await link(tx, me.id, 'cust-me', 'conn-expired', 'inactive');
      const { service, reconnects } = makeService();
      expect(await service.startReconnect(me.id, 'conn-expired', 'https://app/return', tx)).toBe(
        'https://connect.example/?r=conn-expired'
      );
      expect(reconnects).toEqual([
        { connectionId: 'conn-expired', returnTo: 'https://app/return' },
      ]);
    });
  });

  test("reconnecting someone else's bank is refused before Salt Edge is asked", async () => {
    await withTestDb(async (tx) => {
      const me = await makeUser(tx);
      const other = await makeUser(tx);
      await link(tx, other.id, 'cust-other', 'conn-theirs', 'inactive');
      const { service, reconnects } = makeService();
      await expect(
        service.startReconnect(me.id, 'conn-theirs', 'https://app/return', tx)
      ).rejects.toThrow(/not found/i);
      expect(reconnects).toEqual([]);
    });
  });
});
