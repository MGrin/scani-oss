import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCommit,
  VERSION_PLACEHOLDER,
  versionPayload,
  viteVersion,
} from '@scani/ui/vite/version-plugin';

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

type FakeChunk = { type: 'chunk'; fileName: string; code: string };
type FakeAsset = { type: 'asset'; fileName: string; source: string | Uint8Array };
type FakeBundle = Record<string, FakeChunk | FakeAsset>;

// The shape Vite hands `generateBundle`: an entry that reads the version, a
// lazily loaded route, a stylesheet and the page. `define` has already put the
// placeholder where `__SCANI_BUILD_VERSION__` was.
function appBundle(edit: Partial<Record<string, string>> = {}): FakeBundle {
  const files: Array<FakeChunk | FakeAsset> = [
    {
      type: 'chunk',
      fileName: 'assets/index-a1.js',
      code: `const v=${JSON.stringify(VERSION_PLACEHOLDER)};import("./route-b2.js")`,
    },
    { type: 'chunk', fileName: 'assets/route-b2.js', code: 'export const page="Holdings"' },
    { type: 'asset', fileName: 'assets/index-c3.css', source: 'body{color:red}' },
    {
      type: 'asset',
      fileName: 'index.html',
      source: '<script src="/assets/index-a1.js"></script>',
    },
  ];
  const bundle: FakeBundle = {};
  for (const f of files) {
    const changed = edit[f.fileName];
    bundle[f.fileName] =
      changed === undefined
        ? f
        : f.type === 'chunk'
          ? { ...f, code: changed }
          : { ...f, source: changed };
  }
  return bundle;
}

function runBuild(plugin: ReturnType<typeof viteVersion>, bundle: FakeBundle, dir: string): void {
  // The hooks are plain functions here; Vite's ObjectHook union is what the
  // casts get past, and none of them reads its `this` context.
  (plugin.config as (c: object, e: { command: string }) => unknown)({}, { command: 'build' });
  (plugin.buildStart as () => void)();
  const generate = plugin.generateBundle as { handler: (o: object, b: FakeBundle) => void };
  generate.handler({}, bundle);
  (plugin.writeBundle as (o: { dir: string }) => void)({ dir });
}

describe('viteVersion writes what the build was given', () => {
  const saved = process.env.SCANI_COMMIT;
  let dir = '';

  afterEach(() => {
    if (saved === undefined) delete process.env.SCANI_COMMIT;
    else process.env.SCANI_COMMIT = saved;
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  function build(bundle: FakeBundle = appBundle()): Record<string, unknown> {
    dir = mkdtempSync(join(tmpdir(), 'sc964-version-'));
    runBuild(viteVersion(), bundle, dir);
    return JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8'));
  }

  test('SCANI_COMMIT reaches version.json', () => {
    process.env.SCANI_COMMIT = SHA;
    expect(build().commit).toBe(SHA);
  });

  test('the bundle is told the same version version.json carries', () => {
    const bundle = appBundle();
    const written = build(bundle).version as string;
    const entry = bundle['assets/index-a1.js'] as FakeChunk;
    expect(entry.code).toContain(JSON.stringify(written));
    expect(entry.code).not.toContain(VERSION_PLACEHOLDER);
    expect(written).not.toBe('dev');
  });

  test('a dev server tells the bundle dev, which offers nothing', () => {
    const config = viteVersion().config as (
      c: object,
      e: { command: string }
    ) => { define: { __SCANI_BUILD_VERSION__: string } };
    expect(JSON.parse(config({}, { command: 'serve' }).define.__SCANI_BUILD_VERSION__)).toBe('dev');
  });

  test('without SCANI_COMMIT the file still carries a version, and no commit', () => {
    delete process.env.SCANI_COMMIT;
    const got = build();
    expect(typeof got.version).toBe('string');
    expect(got).not.toHaveProperty('commit');
  });
});

// SC-1360: the version used to be `Date.now()`, so every deploy, backend-only
// ones included, offered the update banner to an app that had not changed.
describe('the version is the build output, not the moment of the build', () => {
  const versionOf = (edit: Partial<Record<string, string>> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'sc1360-version-'));
    try {
      runBuild(viteVersion(), appBundle(edit), dir);
      return JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')).version as string;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('the same output is the same version, so an unchanged app offers no update', () => {
    expect(versionOf()).toBe(versionOf());
  });

  test('a one-character change to a lazily loaded route is a new version', () => {
    expect(versionOf({ 'assets/route-b2.js': 'export const page="Holding"' })).not.toBe(
      versionOf()
    );
  });

  test('a stylesheet or page change is a new version too', () => {
    expect(versionOf({ 'assets/index-c3.css': 'body{color:blue}' })).not.toBe(versionOf());
    expect(versionOf({ 'index.html': '<script src="/assets/index-a2.js"></script>' })).not.toBe(
      versionOf()
    );
  });

  test('the placeholder and the version it becomes are the same length, so source maps still line up', () => {
    expect(versionOf()).toHaveLength(VERSION_PLACEHOLDER.length);
  });
});
