import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AccountWrapperRepository } from '../../src/repositories/AccountWrapperRepository';
import { withTestDb } from '../../test/helpers/db';

// SC-1645: the v1 wrappers are Sure's US, UK, CA, AU, EU and generic codes
// (we-promise/sure @ 196355b1), each in one of four buckets. India is SC-1673.

const repo = () => Container.get(AccountWrapperRepository);

describe('AccountWrapperRepository', () => {
  test('seeds the 46 v1 wrappers with their buckets', async () => {
    await withTestDb(async (tx) => {
      const rows = await repo().list(tx);
      expect(rows).toHaveLength(46);
      const by = (t: string) => rows.filter((r) => r.treatment === t).length;
      expect([by('general'), by('deferred'), by('exempt'), by('advantaged')]).toEqual([
        10, 24, 6, 6,
      ]);
      expect(rows.find((r) => r.code === 'isa')).toMatchObject({
        region: 'uk',
        treatment: 'exempt',
      });
      expect(rows.find((r) => r.code === 'non_registered')).toMatchObject({
        region: 'ca',
        treatment: 'general',
      });
      expect(rows.find((r) => r.code === 'pension')).toMatchObject({
        region: null,
        treatment: 'deferred',
      });
      expect(rows.some((r) => r.code === 'ppf')).toBe(false);
    });
  });

  test('lists in display order and finds one by code', async () => {
    await withTestDb(async (tx) => {
      const rows = await repo().list(tx);
      expect(rows[0]?.code).toBe('brokerage');
      expect(rows.at(-1)?.code).toBe('other');
      expect(await repo().findByCode('roth_ira', tx)).toMatchObject({ treatment: 'exempt' });
      expect(await repo().findByCode('nope', tx)).toBeNull();
    });
  });
});
