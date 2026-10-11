import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { inArray } from 'drizzle-orm';
import { BillCalendarFeedService } from '../../../src/calendar/bill-calendar-feed';
import { makeAuthedCaller, makeUnauthedCaller } from '../../helpers/test-caller';

// SC-1654: Settings turns the bills calendar feed on, rotates it and turns it off.

const created: string[] = [];
let user: typeof schema.users.$inferSelect;

beforeAll(async () => {
  const [row] = await db
    .insert(schema.users)
    .values({ email: `sc1654-router-${randomUUID().slice(0, 8)}@scani.local`, name: 'router' })
    .returning();
  if (!row) throw new Error('user insert failed');
  user = row;
  created.push(row.id);
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, created));
});

const tokenOf = (url: string) => /\/calendar\/(.+)\.ics$/.exec(url)?.[1] ?? '';

describe('billCalendar router', () => {
  test('signed out is refused', async () => {
    await expect(makeUnauthedCaller().billCalendar.status()).rejects.toThrow();
  });

  test('off by default; turning on returns the URL once and it resolves', async () => {
    const caller = makeAuthedCaller(user);
    expect((await caller.billCalendar.status()).enabled).toBe(false);
    const { url } = await caller.billCalendar.enable();
    expect(url).toMatch(/^https?:\/\/[^/]+\/calendar\/scani_cal_[A-Za-z0-9_-]{43}\.ics$/);
    expect(await new BillCalendarFeedService().resolve(tokenOf(url))).toBe(user.id);
    const status = await caller.billCalendar.status();
    expect(status.enabled).toBe(true);
    expect(JSON.stringify(status)).not.toContain(tokenOf(url));
  });

  test('rotate gives a new URL and kills the old one; disable kills it too', async () => {
    const caller = makeAuthedCaller(user);
    const { url: first } = await caller.billCalendar.enable();
    const { url: second } = await caller.billCalendar.rotate();
    const feeds = new BillCalendarFeedService();
    expect(await feeds.resolve(tokenOf(first))).toBeNull();
    expect(await feeds.resolve(tokenOf(second))).toBe(user.id);
    await caller.billCalendar.disable();
    expect(await feeds.resolve(tokenOf(second))).toBeNull();
    expect((await caller.billCalendar.status()).enabled).toBe(false);
  });

  test('rotating a feed that is off is refused and leaves it off', async () => {
    const caller = makeAuthedCaller(user);
    await caller.billCalendar.disable();
    await expect(caller.billCalendar.rotate()).rejects.toThrow();
    expect((await caller.billCalendar.status()).enabled).toBe(false);
  });
});
