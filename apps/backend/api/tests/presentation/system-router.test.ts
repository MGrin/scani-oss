import { describe, expect, it } from 'bun:test';
import { PingOutput, systemRouter } from '../../src/presentation/routers/system';
import type { Context } from '../../src/presentation/trpc';

function stubContext(): Context {
  return {
    requestId: 'test-request',
    startTime: Date.now(),
    requestCache: new Map(),
    headers: null,
    sessionRevokeLimiter: {} as Context['sessionRevokeLimiter'],
    userId: null,
    email: null,
    isAuthenticated: false,
    dbUser: null,
  };
}

describe('system router', () => {
  it('ping returns ok + service name', async () => {
    const caller = systemRouter.createCaller(stubContext());
    const result = await caller.ping();
    expect(result).toEqual({ status: 'ok', service: 'api' });
  });

  it('PingOutput rejects a wrong status', () => {
    expect(PingOutput.safeParse({ status: 'bad', service: 'api' }).success).toBe(false);
  });
});
