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
