import { describe, expect, test } from 'bun:test';
import { APP_OPEN_REFRESH } from '../../src/user-jobs/app-open-refresh';
import { REFRESH_ACCOUNT_BALANCE } from '../../src/user-jobs/refresh-account-balance';

describe('REFRESH_ACCOUNT_BALANCE descriptor', () => {
  test('schema accepts an account-level payload with no holdingId (the "Sync now" case)', () => {
    const accountLevel = { userId: 'u', requestId: 'r', accountId: 'a' };
    expect(() => REFRESH_ACCOUNT_BALANCE.schema.parse(accountLevel)).not.toThrow();
  });

  test('schema still accepts a holding-level payload with holdingId', () => {
    const holdingLevel = { userId: 'u', requestId: 'r', accountId: 'a', holdingId: 'h' };
    expect(() => REFRESH_ACCOUNT_BALANCE.schema.parse(holdingLevel)).not.toThrow();
  });

  test('schema rejects a payload missing accountId', () => {
    const bad = { userId: 'u', requestId: 'r', holdingId: 'h' };
    expect(() => REFRESH_ACCOUNT_BALANCE.schema.parse(bad)).toThrow();
  });

  test('jobId dedups per (user, account) — independent of holdingId/requestId', () => {
    const accountOnly = REFRESH_ACCOUNT_BALANCE.computeJobId({
      userId: 'u',
      requestId: 'r1',
      accountId: 'a',
    });
    const fromHolding = REFRESH_ACCOUNT_BALANCE.computeJobId({
      userId: 'u',
      requestId: 'r2',
      accountId: 'a',
      holdingId: 'h',
    });
    // A "Sync now" click and a per-holding refresh on the same account
    // collapse onto one in-flight job.
    expect(accountOnly).toBe(fromHolding);
  });

  test('jobId differs across accounts', () => {
    const base = { userId: 'u', requestId: 'r' };
    expect(REFRESH_ACCOUNT_BALANCE.computeJobId({ ...base, accountId: 'a1' })).not.toBe(
      REFRESH_ACCOUNT_BALANCE.computeJobId({ ...base, accountId: 'a2' })
    );
  });

  test('summary surfaces accountId (holdingId may be absent for account-level)', () => {
    expect(
      REFRESH_ACCOUNT_BALANCE.summarizePayload({ userId: 'u', requestId: 'r', accountId: 'a' })
    ).toEqual({
      holdingId: undefined,
      accountId: 'a',
      requestId: 'r',
    });
  });

  // SC-1724: the Jobs page folds the refreshes one app-open queued into one row
  // by this id, so both halves must record the same one.
  test("summary carries the requestId the app-open's own summary carries", () => {
    const requestId = 'open-1';
    expect(
      REFRESH_ACCOUNT_BALANCE.summarizePayload({ userId: 'u', requestId, accountId: 'a' }).requestId
    ).toBe(APP_OPEN_REFRESH.summarizePayload({ userId: 'u', requestId }).requestId);
    expect(APP_OPEN_REFRESH.summarizePayload({ userId: 'u', requestId })).toEqual({ requestId });
  });
});
