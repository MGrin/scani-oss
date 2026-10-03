import { afterAll, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { viteVersion } from '@scani/ui/vite/version-plugin';
import { build } from 'vite';

/**
 * SC-1521. The update banner fired after almost every deploy because the
 * values that change on EVERY commit — the Sentry release, the build commit and
 * the core-release facts — were compiled into the app bundle. The version is a
 * hash of that bundle (SC-1360), so a backend-only merge produced a new version
 * and a new entry-chunk name: 52 merges to main in two days, 5 of them touching
 * the app. A real build is the only instrument here, because the chunk FILE
 * NAMES are part of what changed, and Rollup names them before any hook of
 * ours sees the code.
 */

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const coreBuild = (commit: string, pending: number, fingerprint: string) =>
  JSON.stringify({
    productVersion: '0.51.0',
    releaseCommit: 'cccccccccccccccccccccccccccccccccccccccc',
    releaseFingerprint: 'd'.repeat(64),
    coreFingerprint: fingerprint.repeat(64),
    pendingChangeCount: pending,
    commit,
  });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SOURCE = `
const meta = document.querySelector('meta[name="scani-build"]');
document.title = [meta && meta.content, __SCANI_BUILD_VERSION__].join('|');
import('./route.js').then((m) => m.render());
`;

async function buildApp(env: Record<string, string>, route = 'Holdings') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sc1521-app-')));
  dirs.push(root);
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  writeFileSync(join(root, 'main.js'), SOURCE);
  writeFileSync(join(root, 'route.js'), `export const render = () => ${JSON.stringify(route)};`);
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    await build({ root, logLevel: 'silent', plugins: [viteVersion()], build: { outDir: 'dist' } });
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const dist = join(root, 'dist');
  const assets = readdirSync(join(dist, 'assets')).sort();
  const js = assets
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dist, 'assets', f), 'utf8'))
    .join('\n');
  const version = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8')).version as string;
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  return { version, assets, js, html };
}

const commitEnv = (sha: string, pending: number, fingerprint: string) => ({
  SCANI_COMMIT: sha,
  VITE_SENTRY_RELEASE: sha,
  SCANI_CORE_BUILD: coreBuild(sha, pending, fingerprint),
});

describe('a commit that does not change the app does not change its version', () => {
  test('same source, different commit: same version and same chunk names', async () => {
    const one = await buildApp(commitEnv(A, 601, 'e'));
    const two = await buildApp(commitEnv(B, 602, 'f'));
    expect(two.version).toBe(one.version);
    expect(two.assets).toEqual(one.assets);
  }, 60_000);

  test('same source, different commit: every chunk is byte-identical', async () => {
    const one = await buildApp(commitEnv(A, 601, 'e'));
    const two = await buildApp(commitEnv(B, 602, 'f'));
    expect(two.js).toBe(one.js);
    expect(two.js).not.toContain(B);
    expect(two.js).not.toContain('f'.repeat(64));
  }, 60_000);

  test('index.html names the commit, count, fingerprint and release; the bundle its version', async () => {
    const got = await buildApp(commitEnv(B, 602, 'f'));
    const meta = got.html.match(/<meta name="scani-build" content="([^"]*)">/);
    expect(meta).not.toBeNull();
    const identity = JSON.parse(
      (meta?.[1] ?? '').replaceAll('&quot;', '"').replaceAll('&amp;', '&')
    );
    expect(identity.commit).toBe(B);
    expect(identity.sentryRelease).toBe(B);
    expect(identity.coreBuild.pendingChangeCount).toBe(602);
    expect(identity.coreBuild.coreFingerprint).toBe('f'.repeat(64));
    expect(got.js).toContain(got.version);
    expect(got.html + got.js).not.toMatch(/SCANI_[A-Z_]*PH/);
  }, 60_000);

  test('the control: a one-word change to a lazily loaded route is still a new version', async () => {
    const one = await buildApp(commitEnv(A, 601, 'e'));
    const changed = await buildApp(commitEnv(A, 601, 'e'), 'Holding');
    expect(changed.version).not.toBe(one.version);
  }, 60_000);
});
