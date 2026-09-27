import { afterEach, describe, expect, test } from 'bun:test';
import { bundleVersion, deployedVersion, offersOnFirstRead } from '@scani/ui/hooks/useAppUpdate';
import { versionPayload } from '@scani/ui/vite/version-plugin';

/**
 * SC-964 added `commit` to `/version.json`. The update banner keys on
 * `version` alone, so the new field must change nothing about detection —
 * these feed the hook's reader the payloads the build plugin actually writes.
 */

const SHA = 'cee35445753d2c8ecc3f4606fc0fbcf7772a6935';
const AT = new Date('2026-09-11T10:00:00.000Z');

/** Round-tripped through JSON, which is what `response.json()` hands the hook. */
function served(buildHash: string, commit: string | undefined): unknown {
  return JSON.parse(JSON.stringify(versionPayload(buildHash, AT, commit)));
}

describe('deployedVersion', () => {
  test('a payload with a commit reads the same version as one without', () => {
    expect(deployedVersion(served('1-aaa', SHA))).toBe('1-aaa');
    expect(deployedVersion(served('1-aaa', undefined))).toBe('1-aaa');
  });

  test('a new build is detected across the payload change, in both directions', () => {
    // The first client after this ships holds a pre-SC-964 version string.
    expect(deployedVersion(served('1-aaa', undefined))).not.toBe(
      deployedVersion(served('2-bbb', SHA))
    );
    expect(deployedVersion(served('1-aaa', SHA))).not.toBe(
      deployedVersion(served('2-bbb', undefined))
    );
  });

  test('two builds of ONE commit are still two deploys', () => {
    expect(deployedVersion(served('1-aaa', SHA))).not.toBe(deployedVersion(served('2-bbb', SHA)));
  });

  test('the same build is not an update', () => {
    expect(deployedVersion(served('1-aaa', SHA))).toBe(deployedVersion(served('1-aaa', SHA)));
  });

  test('the dev server and anything that is not the payload offer nothing', () => {
    expect(deployedVersion({ version: 'dev', buildTime: AT.toISOString() })).toBeNull();
    expect(deployedVersion({ commit: SHA })).toBeNull();
    expect(deployedVersion({ version: '' })).toBeNull();
    expect(deployedVersion({ version: 42 })).toBeNull();
    expect(deployedVersion(null)).toBeNull();
    expect(deployedVersion('<!doctype html>')).toBeNull();
  });
});

/**
 * The first read of a page load used to compare the served version with the one
 * the PREVIOUS visit saw. A page that had just loaded the new build was offered
 * the update anyway, once after every deploy; with a dozen deploys a day the
 * banner read as appearing at random.
 */
describe('offersOnFirstRead', () => {
  test('a page already running the served build is not offered, whatever the last visit saw', () => {
    expect(offersOnFirstRead('2-b', '2-b', '1-a')).toBe(false);
    expect(offersOnFirstRead('2-b', '2-b', null)).toBe(false);
  });

  test('a page running an older bundle is offered, even when the last visit already saw the new one', () => {
    expect(offersOnFirstRead('2-b', '1-a', '2-b')).toBe(true);
    expect(offersOnFirstRead('2-b', '1-a', null)).toBe(true);
  });

  test('a bundle that cannot say falls back to the last visit', () => {
    expect(offersOnFirstRead('2-b', null, '1-a')).toBe(true);
    expect(offersOnFirstRead('2-b', null, '2-b')).toBe(false);
    expect(offersOnFirstRead('2-b', null, null)).toBe(false);
  });
});

describe('bundleVersion', () => {
  const g = globalThis as { __SCANI_BUILD_VERSION__?: unknown };
  afterEach(() => {
    delete g.__SCANI_BUILD_VERSION__;
  });

  test('a build without the plugin names no version', () => {
    expect(bundleVersion()).toBeNull();
  });

  test('reads the id the build put in', () => {
    g.__SCANI_BUILD_VERSION__ = '7-xyz';
    expect(bundleVersion()).toBe('7-xyz');
  });

  test('a dev bundle is not a version', () => {
    g.__SCANI_BUILD_VERSION__ = 'dev';
    expect(bundleVersion()).toBeNull();
  });
});
