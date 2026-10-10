/**
 * bun's `toMatchObject` passes two different `Date`s (SC-1568). The domain
 * preload replaces it with one that also compares them, and every test file
 * in the repo runs under that preload through `bunfig.toml`. These cases
 * read the matcher as a test file sees it, so they go red if the preload
 * stops installing it.
 */

import { describe, expect, test } from 'bun:test';

const a = new Date('2026-01-01T00:00:00.000Z');
const b = new Date('2027-06-01T00:00:00.000Z');

describe('toMatchObject compares Dates (SC-1568)', () => {
  test('a different Date fails', () => {
    expect(() => expect({ at: a, n: 1 }).toMatchObject({ at: b })).toThrow();
  });

  test('a different Date nested in an array fails', () => {
    expect(() => expect({ rows: [{ at: a }] }).toMatchObject({ rows: [{ at: b }] })).toThrow();
  });

  test('.not passes on a different Date', () => {
    expect({ at: a }).not.toMatchObject({ at: b });
  });

  test('a non-Date where a Date is expected fails', () => {
    expect(() => expect({ at: a.toISOString() }).toMatchObject({ at: a })).toThrow();
  });

  test('an equal Date passes', () => {
    expect({ at: a, n: 1 }).toMatchObject({ at: new Date(a) });
  });

  test('an asymmetric matcher still decides its own field', () => {
    expect({ at: a }).toMatchObject({ at: expect.any(Date) });
  });

  test('control: a different number fails, as it always did', () => {
    expect(() => expect({ n: 1 }).toMatchObject({ n: 2 })).toThrow();
  });
});
