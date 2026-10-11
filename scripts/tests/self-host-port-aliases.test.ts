// SC-1709: compose reads FRONTEND_PORT and MAILPIT_UI_PORT from the shell
// before ./.env, so a box booted with either exported binds that port while
// self-host.sh checked, wrote and printed its own default. And a re-run read
// the ports out of ./.env for the clash check but waited on, and printed,
// SCANI_PORT and SCANI_MAIL_PORT. Each case runs the real script with a fake
// `docker` and a fake `curl` on PATH; the fake curl records the URL the boot
// wait polls, so nothing is pulled, started or reached.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts/self-host.sh');

const FAKE_DOCKER = `#!/bin/bash
case "$*" in
  "compose version --short") echo 2.0.0 ;;
  "compose version") echo "Docker Compose version v2.0.0" ;;
  "version --format"*) echo 29.0.0 ;;
  info) ;;
  "compose -f - config") cat >/dev/null; echo "name: zzportalias" ;;
  "volume inspect"*) exit 1 ;;
  "ps -q --filter"*) printf '%s' "\${FAKE_RUNNING:-}" ;;
  *) exit 0 ;;
esac
`;

// Answers every probe, and appends each URL it was asked for to ./.curl-urls.
const FAKE_CURL = `#!/bin/bash
for a in "$@"; do case "$a" in http://*|https://*) echo "$a" >> "$PWD/.curl-urls" ;; esac; done
exit 0
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freePort(): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = l;
  l.stop();
  return port;
}

function installDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scani-port-alias-'));
  dirs.push(dir);
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  for (const f of ['docker-compose.prod.yml', 'docker-compose.tier2.yml'])
    copyFileSync(join(ROOT, f), join(dir, f));
  return dir;
}

function run(dir: string, env: Record<string, string>) {
  const r = Bun.spawnSync(['bash', SCRIPT], {
    cwd: dir,
    env: { PATH: `${join(dir, '.bin')}:${process.env.PATH}`, HOME: dir, ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const envValue = (dir: string, key: string) =>
  new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(join(dir, '.env'), 'utf8'))?.[1];

const polled = (dir: string) =>
  existsSync(join(dir, '.curl-urls'))
    ? readFileSync(join(dir, '.curl-urls'), 'utf8').trim().split('\n')
    : [];

describe('a fresh install takes the compose names as the port it will bind', () => {
  test('FRONTEND_PORT exported alone is the web port .env records', () => {
    const dir = installDir();
    const web = freePort();
    const r = run(dir, {
      SCANI_SKIP_UP: '1',
      FRONTEND_PORT: String(web),
      SCANI_MAIL_PORT: String(freePort()),
      SEAWEEDFS_S3_HOST_PORT: String(freePort()),
    });
    expect(r.code).toBe(0);
    expect(envValue(dir, 'FRONTEND_PORT')).toBe(String(web));
  });

  test('MAILPIT_UI_PORT exported alone is the mail port .env records', () => {
    const dir = installDir();
    const mail = freePort();
    const r = run(dir, {
      SCANI_SKIP_UP: '1',
      SCANI_PORT: String(freePort()),
      MAILPIT_UI_PORT: String(mail),
      SEAWEEDFS_S3_HOST_PORT: String(freePort()),
    });
    expect(r.code).toBe(0);
    expect(envValue(dir, 'MAILPIT_UI_PORT')).toBe(String(mail));
  });

  test('SCANI_PORT and FRONTEND_PORT naming two ports is refused before anything is written', () => {
    const dir = installDir();
    const [a, b] = [freePort(), freePort()];
    const r = run(dir, {
      SCANI_SKIP_UP: '1',
      SCANI_PORT: String(a),
      FRONTEND_PORT: String(b),
      SCANI_MAIL_PORT: String(freePort()),
      SEAWEEDFS_S3_HOST_PORT: String(freePort()),
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`SCANI_PORT=${a}`);
    expect(r.out).toContain(`FRONTEND_PORT=${b}`);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  test('control: SCANI_PORT alone still sets the web port', () => {
    const dir = installDir();
    const web = freePort();
    const r = run(dir, {
      SCANI_SKIP_UP: '1',
      SCANI_PORT: String(web),
      SCANI_MAIL_PORT: String(freePort()),
      SEAWEEDFS_S3_HOST_PORT: String(freePort()),
    });
    expect(r.code).toBe(0);
    expect(envValue(dir, 'FRONTEND_PORT')).toBe(String(web));
  });
});

describe('a re-run waits on, and prints, the ports in ./.env', () => {
  function existingInstall(web: number, mail: number): string {
    const dir = installDir();
    writeFileSync(
      join(dir, '.env'),
      `SCANI_DEPLOYMENT_TIER=1\nFRONTEND_PORT=${web}\nMAILPIT_UI_PORT=${mail}\nSEAWEEDFS_S3_HOST_PORT=${freePort()}\n`
    );
    return dir;
  }

  test('the boot wait polls the web port .env names, and the banner prints both', () => {
    const [web, mail] = [freePort(), freePort()];
    const dir = existingInstall(web, mail);
    const r = run(dir, { FAKE_RUNNING: 'abc123' });
    expect(r.code).toBe(0);
    expect(polled(dir)).toContain(`http://localhost:${web}/healthz`);
    expect(r.out).toContain(`Scani is running at http://localhost:${web}`);
    expect(r.out).toContain(`Sign-in:   http://localhost:${mail}`);
  });
});
