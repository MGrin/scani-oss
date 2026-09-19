import { describe, expect, test } from 'bun:test';
import { SaltEdgeConnectionService } from '@scani/domain/services/integrations/SaltEdgeConnectionService';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { saltedgeRouter } from '../../src/presentation/routers/saltedge';
import { buildAuthedContext, buildUnauthedContext } from '../helpers/test-caller';

restoreContainerAfterAll();

const user = { id: 'user-1', email: 'u@example.com' } as Parameters<typeof buildAuthedContext>[0];

describe('saltedge.startConnect', () => {
  test("returns the widget url, with the return page on the app's own origin", async () => {
    const calls: [string, string][] = [];
    Container.set(SaltEdgeConnectionService, {
      startConnect: async (userId: string, returnTo: string) => {
        calls.push([userId, returnTo]);
        return 'https://www.saltedge.com/connect?token=t';
      },
    } as unknown as SaltEdgeConnectionService);
    const caller = saltedgeRouter.createCaller(buildAuthedContext(user));
    expect(await caller.startConnect()).toEqual({
      connectUrl: 'https://www.saltedge.com/connect?token=t',
    });
    expect(calls[0]?.[0]).toBe('user-1');
    expect(calls[0]?.[1]).toMatch(/\/integrations\/saltedge\/return$/);
  });

  test('an unconfigured deployment answers PRECONDITION_FAILED, not a 500', async () => {
    Container.set(SaltEdgeConnectionService, {
      startConnect: async () => {
        throw new Error('Salt Edge is not configured on this deployment');
      },
    } as unknown as SaltEdgeConnectionService);
    const caller = saltedgeRouter.createCaller(buildAuthedContext(user));
    await expect(caller.startConnect()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  test('requires a session', async () => {
    const caller = saltedgeRouter.createCaller(buildUnauthedContext());
    await expect(caller.startConnect()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('saltedge.connections', () => {
  test("lists the caller's banks, and nobody else's", async () => {
    const asked: string[] = [];
    const updatedAt = new Date('2026-09-19T10:00:00Z');
    Container.set(SaltEdgeConnectionService, {
      listConnections: async (userId: string) => {
        asked.push(userId);
        return [
          {
            connectionId: 'c1',
            status: 'inactive',
            lastError: 'expired',
            updatedAt,
            needsReconnect: true,
          },
        ];
      },
    } as unknown as SaltEdgeConnectionService);
    const caller = saltedgeRouter.createCaller(buildAuthedContext(user));
    expect(await caller.connections()).toEqual([
      {
        connectionId: 'c1',
        status: 'inactive',
        lastError: 'expired',
        updatedAt,
        needsReconnect: true,
      },
    ]);
    expect(asked).toEqual(['user-1']);
  });
});

describe('saltedge.startReconnect', () => {
  test('returns the widget url for that connection, returning to the same page', async () => {
    const calls: [string, string, string][] = [];
    Container.set(SaltEdgeConnectionService, {
      startReconnect: async (userId: string, connectionId: string, returnTo: string) => {
        calls.push([userId, connectionId, returnTo]);
        return 'https://www.saltedge.com/connect?token=r';
      },
    } as unknown as SaltEdgeConnectionService);
    const caller = saltedgeRouter.createCaller(buildAuthedContext(user));
    expect(await caller.startReconnect({ connectionId: 'c1' })).toEqual({
      connectUrl: 'https://www.saltedge.com/connect?token=r',
    });
    expect(calls[0]?.slice(0, 2)).toEqual(['user-1', 'c1']);
    expect(calls[0]?.[2]).toMatch(/\/integrations\/saltedge\/return$/);
  });

  test("another user's connection answers NOT_FOUND", async () => {
    Container.set(SaltEdgeConnectionService, {
      startReconnect: async () => {
        throw new Error('Salt Edge connection not found');
      },
    } as unknown as SaltEdgeConnectionService);
    const caller = saltedgeRouter.createCaller(buildAuthedContext(user));
    await expect(caller.startReconnect({ connectionId: 'c9' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('an empty connection id is refused by the schema', async () => {
    const caller = saltedgeRouter.createCaller(buildAuthedContext(user));
    await expect(caller.startReconnect({ connectionId: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
