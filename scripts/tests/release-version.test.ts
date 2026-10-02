import { describe, expect, test } from 'bun:test';
import { releaseVersion } from '../release-version';

describe('releaseVersion (SC-1484)', () => {
  test('a release tag publishes as its own version', () => {
    expect(releaseVersion('refs/tags/v0.51.0', '0.51.0')).toEqual({ ok: true, version: '0.51.0' });
  });

  test('a tag the manifest does not name fails before anything is pushed', () => {
    const got = releaseVersion('refs/tags/v0.51.0', '0.50.0');
    expect(got.ok).toBe(false);
  });

  test('a tag that is not bare semver fails', () => {
    expect(releaseVersion('refs/tags/v0.51.0-rc.1', '0.51.0-rc.1').ok).toBe(false);
    expect(releaseVersion('refs/tags/vnext', 'next').ok).toBe(false);
  });

  test('a branch or pull request claims no release', () => {
    expect(releaseVersion('refs/heads/main', '0.50.0')).toEqual({ ok: true, version: '' });
    expect(releaseVersion('refs/pull/12/merge', '0.50.0')).toEqual({ ok: true, version: '' });
  });
});
