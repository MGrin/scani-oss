import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { inArray } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { BillCalendarFeedService } from '../../src/calendar/bill-calendar-feed';
import {
  type BillCalendarRouteDeps,
  registerBillCalendarRoutes,
} from '../../src/calendar/bill-calendar-routes';

// SC-1654: GET /calendar/<token>.ics, public and keyed only by its token.

const OWNER = 'user-owner';
const GOOD = 'scani_cal_good';

function limiter(max = 100) {
  return new InMemoryInflowRateLimiter({
    windowMs: 60_000,
    max,
    namespace: `rl:t-${randomUUID()}`,
  });
}

function mount(overrides: Partial<BillCalendarRouteDeps> = {}) {
  const resolved: string[] = [];
  const deps: BillCalendarRouteDeps = {
    resolve: async (raw) => {
      resolved.push(raw);
      return raw === GOOD ? OWNER : null;
    },
    events: async (userId) =>
      userId === OWNER
        ? [{ uid: 'occ-1', date: '2026-11-01', summary: 'Hyperoptic · 42.00 GBP' }]
        : [],
    limiter: limiter(),
    now: () => new Date('2026-10-10T12:00:00Z'),
    ...overrides,
  };
  const app = new Elysia();
  registerBillCalendarRoutes(app, deps);
  return { app, resolved };
}

const get = (app: Elysia, path: string) => app.handle(new Request(`http://localhost${path}`));

describe('GET /calendar/<token>.ics', () => {
  test('a live token gets the calendar, never cached', async () => {
    const { app } = mount();
    const res = await get(app, `/calendar/${GOOD}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('SUMMARY:Hyperoptic · 42.00 GBP');
  });

  test('an unknown token and a malformed one get the same 404, and both are looked up', async () => {
    const { app, resolved } = mount();
    const unknown = await get(app, '/calendar/scani_cal_nobody.ics');
    const malformed = await get(app, '/calendar/%%%.ics');
    for (const res of [unknown, malformed]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(await unknown.text()).toBe(await malformed.text());
    expect(resolved).toEqual(['scani_cal_nobody', '%%%']);
  });

  test('a path without .ics is the same 404', async () => {
    const { app, resolved } = mount();
    const res = await get(app, `/calendar/${GOOD}`);
    expect(res.status).toBe(404);
    expect(resolved).toEqual([GOOD]);
  });

  test('too many requests for one token is 429 with Retry-After', async () => {
    const { app } = mount({ limiter: limiter(2) });
    await get(app, `/calendar/${GOOD}.ics`);
    await get(app, `/calendar/${GOOD}.ics`);
    const res = await get(app, `/calendar/${GOOD}.ics`);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('a revoked URL, end to end against the database', () => {
  const service = new BillCalendarFeedService();
  const created: string[] = [];
  let userId: string;

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `sc1654-route-${randomUUID().slice(0, 8)}@scani.local`, name: 'route' })
      .returning();
    if (!user) throw new Error('user insert failed');
    userId = user.id;
    created.push(user.id);
  });

  afterAll(async () => {
    await db.delete(schema.users).where(inArray(schema.users.id, created));
  });

  test('after a rotate the old URL is 404 and the new one is 200; after turning off both are 404', async () => {
    const { app } = mount({ resolve: (raw) => service.resolve(raw), events: async () => [] });
    const old = await service.enable(userId);
    const fresh = await service.rotate(userId);
    expect((await get(app, `/calendar/${old}.ics`)).status).toBe(404);
    expect((await get(app, `/calendar/${fresh}.ics`)).status).toBe(200);
    await service.disable(userId);
    expect((await get(app, `/calendar/${fresh}.ics`)).status).toBe(404);
  });
});
