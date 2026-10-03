// SC-1526: a taken host port must stop `scripts/self-host.sh` before it writes
// anything, naming the port and the setting that moves it. Each case runs the
// real script under bash with a fake `docker` on PATH, so nothing is pulled or
// started; the control arms prove a free port, a running install of its own and
// a Tier 2 install (no mail catcher) are not refused.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  "compose -f - config") cat >/dev/null; echo "name: zzportclash" ;;
  "volume inspect"*) exit 1 ;;
  "ps -q --filter"*) printf '%s' "\${FAKE_RUNNING:-}" ;;
  *) echo "fake docker: unexpected: $*" >&2; exit 0 ;;
esac
`;

const held: Array<{ stop(): void }> = [];
const dirs: string[] = [];

afterEach(() => {
  for (const l of held.splice(0)) l.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function listen(): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  held.push(l);
  return l.port;
}

function freePort(): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = l;
  l.stop();
  return port;
}

function installDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scani-port-clash-'));
  dirs.push(dir);
  mkdirBin(dir);
  for (const f of ['docker-compose.prod.yml', 'docker-compose.tier2.yml'])
    copyFileSync(join(ROOT, f), join(dir, f));
  return dir;
}

function mkdirBin(dir: string): void {
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
}

function run(dir: string, env: Record<string, string>) {
  const r = Bun.spawnSync(['bash', SCRIPT], {
    cwd: dir,
    env: {
      PATH: `${join(dir, '.bin')}:${process.env.PATH}`,
      HOME: dir,
      SCANI_SKIP_UP: '1',
      ...env,
    },
  });
  return { code: r.exitCode, stderr: r.stderr.toString(), stdout: r.stdout.toString() };
}

function ports(over: Partial<Record<'web' | 'mail' | 's3', number>> = {}) {
  return {
    SCANI_PORT: String(over.web ?? freePort()),
    SCANI_MAIL_PORT: String(over.mail ?? freePort()),
    SEAWEEDFS_S3_HOST_PORT: String(over.s3 ?? freePort()),
  };
}

describe('self-host.sh refuses a taken host port before writing anything', () => {
  test('control: free ports pass and the install proceeds to write .env', () => {
    const dir = installDir();
    const r = run(dir, ports());
    expect(r.stderr).not.toContain('already in use');
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, '.env'))).toBe(true);
  });

  test('a taken web port is refused, naming the port and SCANI_PORT', () => {
    const dir = installDir();
    const web = listen();
    const r = run(dir, ports({ web }));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`port ${web} is already in use`);
    expect(r.stderr).toContain(`SCANI_PORT=<a free port> bash`);
    expect(r.stderr).toContain('Nothing has been written or started.');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  test('a taken mail or storage port names its own setting', () => {
    const mail = listen();
    const r1 = run(installDir(), ports({ mail }));
    expect(r1.code).not.toBe(0);
    expect(r1.stderr).toContain(`port ${mail} is already in use`);
    expect(r1.stderr).toContain('SCANI_MAIL_PORT=');

    const s3 = listen();
    const r2 = run(installDir(), ports({ s3 }));
    expect(r2.code).not.toBe(0);
    expect(r2.stderr).toContain(`port ${s3} is already in use`);
    expect(r2.stderr).toContain('SEAWEEDFS_S3_HOST_PORT=');
  });

  test('a re-run reads the ports from ./.env and points at the line to change', () => {
    const dir = installDir();
    const web = listen();
    const env = `SCANI_DEPLOYMENT_TIER=1\nFRONTEND_PORT=${web}\nMAILPIT_UI_PORT=${freePort()}\nSEAWEEDFS_S3_HOST_PORT=${freePort()}\n`;
    writeFileSync(join(dir, '.env'), env);
    const r = run(dir, ports());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`change FRONTEND_PORT=${web} in ./.env`);
  });

  test('control: a running install of this project holds its own ports and is not refused', () => {
    const dir = installDir();
    const r = run(dir, { ...ports({ web: listen() }), FAKE_RUNNING: 'abc123' });
    expect(r.stderr).not.toContain('already in use');
    expect(r.code).toBe(0);
  });

  test('control: Tier 2 runs no mail catcher, so its port is not checked', () => {
    const dir = installDir();
    const mail = listen();
    const env = `SCANI_DEPLOYMENT_TIER=2\nFRONTEND_PORT=${freePort()}\nMAILPIT_UI_PORT=${mail}\nSEAWEEDFS_S3_HOST_PORT=${freePort()}\n`;
    writeFileSync(join(dir, '.env'), env);
    const r = run(dir, ports());
    expect(r.stderr).not.toContain('already in use');
    expect(r.code).toBe(0);
  });
});
