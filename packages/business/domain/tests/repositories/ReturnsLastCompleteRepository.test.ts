import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { ReturnsLastCompleteRepository } from '../../src/repositories/ReturnsLastCompleteRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

const repo = () => Container.get(ReturnsLastCompleteRepository);

const AT = new Date('2026-10-10T12:00:00.000Z');
const minutesAfter = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

describe('ReturnsLastCompleteRepository (SC-1694)', () => {
  test('keeps one answer per user, scope and window', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = {
        userId: user.id,
        scopeKey: '{"kind":"user"}',
        windowKey: 'ytd',
        baseCurrencyId: 'usd',
        answer: { returns: { twr: '0.3' }, benchmarks: [] },
        computedAt: AT,
      };
      await repo().save(row, tx);
      await repo().save({ ...row, windowKey: 'all', answer: { other: true } }, tx);

      const ytd = await repo().find(user.id, '{"kind":"user"}', 'ytd', tx);
      expect(ytd?.answer).toEqual({ returns: { twr: '0.3' }, benchmarks: [] });
      expect(ytd?.computedAt.toISOString()).toBe(AT.toISOString());
      expect(await repo().find(user.id, '{"kind":"user"}', '1y', tx)).toBeNull();
    });
  });

  test('a fresh answer is kept, not rewritten on every load', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = {
        userId: user.id,
        scopeKey: '{"kind":"user"}',
        windowKey: 'ytd',
        baseCurrencyId: 'usd',
        answer: { n: 1 },
        computedAt: AT,
      };
      await repo().save(row, tx);
      await repo().save({ ...row, answer: { n: 2 }, computedAt: minutesAfter(2) }, tx);
      expect((await repo().find(user.id, row.scopeKey, 'ytd', tx))?.answer).toEqual({ n: 1 });

      // Control: past the five minutes it is replaced.
      await repo().save({ ...row, answer: { n: 3 }, computedAt: minutesAfter(6) }, tx);
      const later = await repo().find(user.id, row.scopeKey, 'ytd', tx);
      expect(later?.answer).toEqual({ n: 3 });
      expect(later?.computedAt.toISOString()).toBe(minutesAfter(6).toISOString());
    });
  });

  test('a change of base currency replaces it at once', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = {
        userId: user.id,
        scopeKey: '{"kind":"user"}',
        windowKey: 'ytd',
        baseCurrencyId: 'usd',
        answer: { n: 1 },
        computedAt: AT,
      };
      await repo().save(row, tx);
      await repo().save(
        { ...row, baseCurrencyId: 'eur', answer: { n: 2 }, computedAt: minutesAfter(1) },
        tx
      );
      const kept = await repo().find(user.id, row.scopeKey, 'ytd', tx);
      expect(kept?.baseCurrencyId).toBe('eur');
      expect(kept?.answer).toEqual({ n: 2 });
    });
  });
});
