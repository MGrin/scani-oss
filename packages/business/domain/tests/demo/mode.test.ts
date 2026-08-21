import { describe, expect, test } from 'bun:test';
import {
  assertDemoOnlyUsers,
  DEMO_MODE_ENV_VAR,
  DEMO_USER_EMAIL,
  DemoModeRefused,
  demoIdentity,
  foreignUserEmails,
  isDemoModeRequested,
} from '../../src/demo';
import { buildDemoDataset } from '../../src/demo/dataset';

/**
 * SC-466. Demo mode gives every anonymous request a session, so the guard that
 * decides where it may run is the whole of its safety.
 *
 * A refusing guard is worth nothing until it has been watched to ACCEPT — that
 * is SC-482's lesson, where a marker matched both repositories and the check
 * could never fail. So the legitimate case is asserted here as loudly as the
 * refusals: a database holding the demo persona and nobody else passes, and it
 * is the same call that refuses everything below it.
 */
describe('demo mode is off unless something says exactly 1', () => {
  test.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['true', false],
    ['TRUE', false],
    ['yes', false],
    ['on', false],
    [' 1', false],
    ['1 ', false],
    ['11', false],
    ['1', true],
  ])('%p → %p', (value, expected) => {
    expect(isDemoModeRequested({ [DEMO_MODE_ENV_VAR]: value as string | undefined })).toBe(
      expected
    );
  });

  test('an environment that never mentions the variable is off', () => {
    expect(isDemoModeRequested({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('the database guard', () => {
  test('ACCEPTS a database holding the demo persona and nobody else', () => {
    expect(() => assertDemoOnlyUsers([DEMO_USER_EMAIL])).not.toThrow();
  });

  test('accepts it whatever case the row was written in', () => {
    expect(() => assertDemoOnlyUsers(['IVY.CALDER@Demo.Scani.XYZ'])).not.toThrow();
  });

  test('refuses a database holding one real account alongside the persona', () => {
    expect(() => assertDemoOnlyUsers([DEMO_USER_EMAIL, 'someone@example.com'])).toThrow(
      DemoModeRefused
    );
  });

  test('refuses a production-shaped database outright', () => {
    const production = Array.from({ length: 15 }, (_, i) => `user${i}@example.com`);
    expect(() => assertDemoOnlyUsers(production)).toThrow(DemoModeRefused);
  });

  test('names how many foreign accounts it found, so the refusal is diagnosable', () => {
    let message = '';
    try {
      assertDemoOnlyUsers([DEMO_USER_EMAIL, 'a@example.com', 'b@example.com']);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('2 account(s)');
    expect(message).toContain('a@example.com');
  });

  test('refuses an EMPTY database — nothing there proves it is the demo', () => {
    expect(() => assertDemoOnlyUsers([])).toThrow(DemoModeRefused);
  });

  test('a row with a null or blank email is not counted as a foreign account', () => {
    // Better-Auth always writes one, but the column is nullable and a blank
    // string must not be the thing that decides a deployment is production.
    expect(foreignUserEmails([null, '   ', DEMO_USER_EMAIL])).toEqual([]);
  });
});

describe('the demo identity', () => {
  test('is the id the seeder actually writes, so it survives a reset', () => {
    // The reset deletes the user and rewrites it. If these two ever diverged,
    // a demo visitor would hold a session for a user that does not exist —
    // which is the SC-465 defect this ticket is here to remove.
    expect(demoIdentity().id).toBe(buildDemoDataset().user.id);
    expect(demoIdentity().email).toBe(buildDemoDataset().user.email);
  });

  test('does not depend on the anchor, which a reset changes every day', () => {
    expect(buildDemoDataset({ anchorDate: '2026-01-01' }).user.id).toBe(demoIdentity().id);
    expect(buildDemoDataset({ anchorDate: '2027-03-04' }).user.id).toBe(demoIdentity().id);
  });

  test('is never derived from anything a request could supply', () => {
    expect(demoIdentity().email).toBe(DEMO_USER_EMAIL);
  });
});
