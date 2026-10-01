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

describe('servedVersion names the release a public image was published as (SC-1484)', () => {
  test('a release image serves its version beside its commit', () => {
    expect(servedVersion(SHA, '', '0.51.0')).toEqual({ commit: SHA, productVersion: '0.51.0' });
  });

  test('a build given no release claims none', () => {
    expect(servedVersion(SHA, '', undefined)).toEqual({ commit: SHA });
  });

  test('a malformed release drops the label, not the commit', () => {
    expect(servedVersion(SHA, '', 'v0.51.0')).toEqual({ commit: SHA });
  });
});
