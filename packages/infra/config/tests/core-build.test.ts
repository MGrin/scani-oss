import { expect, test } from 'bun:test';
import { readCoreBuild, servedVersion } from '../src/index';

const commit = 'a'.repeat(40);
const mapping = {
  productVersion: '0.49.0',
  releaseCommit: 'b'.repeat(40),
  releaseFingerprint: 'c'.repeat(64),
  coreFingerprint: 'd'.repeat(64),
  pendingChangeCount: 5,
  commit,
};
test('release identity is separate from the build and missing mapping invents no version', () => {
  expect(readCoreBuild(undefined, commit)).toBeUndefined();
  expect(readCoreBuild(JSON.stringify(mapping), commit)).toEqual(mapping);
  expect(() => readCoreBuild(JSON.stringify(mapping), 'f'.repeat(40))).toThrow();
  expect(() =>
    readCoreBuild(JSON.stringify({ ...mapping, productVersion: 'latest' }), commit)
  ).toThrow();
  expect(servedVersion(commit, JSON.stringify(mapping))).toMatchObject({
    commit,
    productVersion: '0.49.0',
    pendingChangeCount: 5,
  });
});

test('a mapping left over from another build costs the label, never the commit', () => {
  const stale = JSON.stringify({ ...mapping, commit: 'f'.repeat(40) });
  expect(servedVersion(commit, stale)).toEqual({ commit });
  expect(servedVersion(commit, 'not json')).toEqual({ commit });
});
