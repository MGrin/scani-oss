import { describe, expect, test } from 'bun:test';
import { servedVersion } from '../src/index';

const SHA = 'a'.repeat(40);

describe('servedVersion names a commit only when it has one (SC-1182)', () => {
  test('a full sha is served', () => {
    expect(servedVersion(SHA)).toEqual({ commit: SHA });
  });

  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['the logger default', 'unknown'],
    ['a short sha', 'abc1234'],
    ['a decorated sha', `${SHA}-dirty`],
    ['upper-case hex', 'A'.repeat(40)],
  ])('%s names no commit', (_label, raw) => {
    expect(servedVersion(raw)).toEqual({});
  });
});
