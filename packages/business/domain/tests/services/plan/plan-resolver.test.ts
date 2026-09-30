import { afterEach, describe, expect, it } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import {
  getPlanResolver,
  PLAN_RESOLVER,
  type PlanAccess,
  type PlanResolver,
  registerPlanResolver,
  UNLIMITED_ACCESS,
} from '../../../src/services/plan/plan-resolver';

restoreContainerAfterAll();

describe('plan resolver seam', () => {
  afterEach(() => {
    Container.remove(PLAN_RESOLVER);
  });

  it('answers unlimited when nothing is registered', async () => {
    expect(await getPlanResolver().forUser('u')).toEqual(UNLIMITED_ACCESS);
    expect(UNLIMITED_ACCESS).toEqual({
      tier: 'unlimited',
      gate: 'none',
      state: 'self-host',
      until: null,
      grants: { app: true, cloud: true },
      aiMonthlyCap: null,
    });
  });

  it('answers with the registered resolver', async () => {
    const access: PlanAccess = {
      tier: 'free',
      gate: 'checkout-required',
      state: 'none',
      until: null,
      grants: { app: false, cloud: false },
      aiMonthlyCap: 5,
    };
    const seen: Array<[string, Date | undefined]> = [];
    const fake: PlanResolver = {
      forUser: async (userId, at) => {
        seen.push([userId, at]);
        return access;
      },
    };
    registerPlanResolver(fake);
    const at = new Date('2026-01-01T00:00:00Z');
    expect(await getPlanResolver().forUser('u', at)).toBe(access);
    expect(seen).toEqual([['u', at]]);
  });

  it('falls back to unlimited once the registration is removed', async () => {
    registerPlanResolver({ forUser: async () => ({ ...UNLIMITED_ACCESS, tier: 'free' }) });
    Container.remove(PLAN_RESOLVER);
    expect((await getPlanResolver().forUser('u')).tier).toBe('unlimited');
  });
});
