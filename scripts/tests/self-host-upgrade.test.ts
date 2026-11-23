import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const DOCKER = `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
case "$*" in
  'compose version --short') echo 2.39.0 ;;
  'compose version') echo 'Docker Compose version v2.39.0' ;;
  'version --format'*) echo 29.0.0 ;;
  info) ;;
  'compose -f - config') cat >/dev/null; echo 'name: upgrade-test' ;;
  'volume inspect'*) exit 1 ;;
  'ps -q --filter'*) echo old-api ;;
  *'config --images')
    for image in api worker data-provider frontend-app migrate; do
      echo "scani/$image:\${FAKE_IMAGE_TAG:-$SCANI_IMAGE_TAG}"
    done ;;
  *'stop --timeout 60'*) exit "\${FAIL_STOP:-0}" ;;
  *'ps --status running --quiet'*) printf '%s' "\${SURVIVING_WRITER:-}"; exit "\${FAIL_STATUS:-0}" ;;
  *'run --rm --no-TTY migrate'*) exit "\${FAIL_MIGRATE:-0}" ;;
  *'up -d --wait'*) exit "\${FAIL_START:-0}" ;;
  *'pull --quiet api worker data-provider frontend-app migrate') ;;
  *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
`;
function run(overrides: Record<string, string> = {}, pin = '0.56.0', existing = true) {
  const dir = mkdtempSync(join(tmpdir(), 'scani-upgrade-'));
  dirs.push(dir);
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'curl'), '#!/bin/bash\nexit 0\n');
  chmodSync(join(bin, 'curl'), 0o755);
  for (const file of ['docker-compose.prod.yml', 'docker-compose.tier2.yml'])
    copyFileSync(join(ROOT, file), join(dir, file));
  if (existing)
    writeFileSync(
      join(dir, '.env'),
      `SCANI_IMAGE_TAG=${pin}\nSCANI_DEPLOYMENT_TIER=${overrides.SCANI_DEPLOYMENT_TIER ?? '1'}\nFRONTEND_PORT=15000\n`
    );
  const trace = join(dir, 'trace');
  const result = Bun.spawnSync(['bash', join(ROOT, 'scripts/self-host.sh')], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      TRACE: trace,
      SCANI_UPGRADE_BACKUP_CONFIRMED: '1',
      ...overrides,
    },
  });
  return {
    code: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    calls: readFileSync(trace, 'utf8'),
  };
}

describe('self-host upgrade maintenance barrier', () => {
  test('stops old writers before migration and waits for the new services', () => {
    const r = run();
    expect(r.code).toBe(0);
    const stop = r.calls.indexOf('stop --timeout 60 frontend-app api worker data-provider');
    const verify = r.calls.indexOf(
      'ps --status running --quiet frontend-app api worker data-provider'
    );
    const migrate = r.calls.indexOf('run --rm --no-TTY migrate');
    expect(stop).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(stop);
    expect(migrate).toBeGreaterThan(verify);
    expect(r.calls.indexOf('up -d --wait')).toBeGreaterThan(migrate);
    expect(r.output).toContain('pulling images (tag: 0.56.0)');
    expect(r.calls).toContain(
      'up -d --wait --wait-timeout 180 --no-deps frontend-app api worker data-provider'
    );
    expect(r.calls).toContain(
      '--profile * pull --quiet api worker data-provider frontend-app migrate'
    );
    expect(r.calls).not.toMatch(/\b(down|volume rm)\b/);
  });
  test('requires the final backup confirmation before changing services', () => {
    const r = run({ SCANI_UPGRADE_BACKUP_CONFIRMED: '' });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('SCANI_UPGRADE_BACKUP_CONFIRMED=1');
    expect(r.calls).not.toContain('run --rm');
    expect(r.calls).not.toContain('stop --timeout');
  });
  test('refuses mutable pins and a mixed image configuration before stopping', () => {
    const mutable = run({}, 'latest');
    expect(mutable.code).not.toBe(0);
    expect(mutable.calls).not.toContain('stop --timeout');
    const mixed = run({ FAKE_IMAGE_TAG: '0.55.6' });
    expect(mixed.code).not.toBe(0);
    expect(mixed.calls).not.toContain('stop --timeout');
  });
  test('control: a fresh install needs no upgrade attestation', () => {
    const r = run({ SCANI_UPGRADE_BACKUP_CONFIRMED: '' }, 'latest', false);
    expect(r.code).toBe(0);
    expect(r.calls).toContain('run --rm --no-TTY migrate');
  });
  test('control: Tier 2 keeps its overlay through stop, migration and startup', () => {
    const r = run({ SCANI_DEPLOYMENT_TIER: '2' });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(
      'up -d --wait --wait-timeout 180 --no-deps frontend-app api worker\n'
    );
    expect(r.calls).toContain('-f docker-compose.prod.yml -f docker-compose.tier2.yml stop');
    expect(r.calls).toContain(
      '-f docker-compose.prod.yml -f docker-compose.tier2.yml --profile migrate run'
    );
  });
  test('an unreadable shutdown status prevents migration', () => {
    const r = run({ FAIL_STATUS: '1' });
    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain('run --rm');
  });
  test('an exported override cannot leave the previous image pin in .env', () => {
    const r = run({ SCANI_IMAGE_TAG: '0.56.1' });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('in .env first');
    expect(r.calls).not.toContain('stop --timeout');
  });
  test('a failed stop prevents migration', () => {
    const r = run({ FAIL_STOP: '1' });
    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain('run --rm');
    expect(r.calls).not.toContain('up -d');
  });
  test('a stop reporting success cannot hide a surviving writer', () => {
    const r = run({ SURVIVING_WRITER: 'still-running-worker' });
    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain('run --rm');
  });
  test('failed migration leaves services stopped', () => {
    const r = run({ FAIL_MIGRATE: '1' });
    expect(r.code).not.toBe(0);
    expect(r.calls).toContain('stop --timeout');
    expect(r.calls).not.toContain('up -d');
    expect(r.output).toContain('remain stopped');
  });
  test('failed service health does not report a successful upgrade', () => {
    const r = run({ FAIL_START: '1' });
    expect(r.code).not.toBe(0);
    expect(r.output).not.toContain('Scani is running');
    expect(r.output).toContain('New services did not become healthy');
    expect(r.calls).toContain('up -d --wait --wait-timeout 180');
  });
});
