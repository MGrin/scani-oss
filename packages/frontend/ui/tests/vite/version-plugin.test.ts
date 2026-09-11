import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCommit, versionPayload, viteVersion } from '@scani/ui/vite/version-plugin';

/**
 * SC-964. `version.json` names the commit a build came from, so the deploy
 * probe can read identity on every Vite site — until now only the app bundle
 * could say which commit it served, and only because it carries a Sentry
 * release.
 */

const SHA = 'cee35445753d2c8ecc3f4606fc0fbcf7772a6935';

describe('readCommit', () => {
  test('a full sha is the commit', () => {
    expect(readCommit(SHA)).toBe(SHA);
  });

  test('unset or empty names no commit — a local build does not guess one', () => {
    expect(readCommit(undefined)).toBeUndefined();
    expect(readCommit('')).toBeUndefined();
  });

  test('a short or decorated sha is refused rather than published', () => {
    expect(() => readCommit('cee3544')).toThrow('40-hex');
    expect(() => readCommit(`${SHA}-dirty`)).toThrow('40-hex');
    expect(() => readCommit(SHA.toUpperCase())).toThrow('40-hex');
  });
});

describe('versionPayload', () => {
  const at = new Date('2026-09-11T10:00:00.000Z');

  test('carries the commit beside the build hash when there is one', () => {
    expect(versionPayload('123-abc', at, SHA)).toEqual({
      version: '123-abc',
      buildTime: '2026-09-11T10:00:00.000Z',
      commit: SHA,
    });
  });

  test('omits the key entirely without one, rather than writing null', () => {
    expect(JSON.stringify(versionPayload('123-abc', at, undefined))).toBe(
      '{"version":"123-abc","buildTime":"2026-09-11T10:00:00.000Z"}'
    );
  });

  // `deploy-local.sh` verifies the built artefact by grepping for this exact
  // byte sequence, so the compact form is part of the contract.
  test('serialises the commit as "commit":"<sha>" with no whitespace', () => {
    expect(JSON.stringify(versionPayload('x', at, SHA))).toContain(`"commit":"${SHA}"`);
  });
});

describe('viteVersion writes what the build was given', () => {
  const saved = process.env.SCANI_COMMIT;
  let dir = '';

  afterEach(() => {
    if (saved === undefined) delete process.env.SCANI_COMMIT;
    else process.env.SCANI_COMMIT = saved;
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  function build(): Record<string, unknown> {
    dir = mkdtempSync(join(tmpdir(), 'sc964-version-'));
    const plugin = viteVersion();
    // The hooks are plain functions here; Vite's ObjectHook union is what the
    // casts get past, and neither hook reads its `this` context.
    (plugin.buildStart as () => void)();
    (plugin.writeBundle as (o: { dir: string }) => void)({ dir });
    return JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'));
  }

  test('SCANI_COMMIT reaches version.json', () => {
    process.env.SCANI_COMMIT = SHA;
    expect(build().commit).toBe(SHA);
  });

  test('without SCANI_COMMIT the file still carries a version, and no commit', () => {
    delete process.env.SCANI_COMMIT;
    const got = build();
    expect(typeof got.version).toBe('string');
    expect(got).not.toHaveProperty('commit');
  });
});
