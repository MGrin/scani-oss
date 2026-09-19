/**
 * SC-1269. The watchdog runs for real against a `sleep` standing in for the
 * worker and a file standing in for /proc/meminfo, so what is asserted is
 * whether the process survives.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'memory-watchdog.sh');
const dirs: string[] = [];
const victims: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const v of victims.splice(0)) v.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function meminfo(availableMb: number | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
  dirs.push(dir);
  const path = join(dir, 'meminfo');
  write(path, availableMb);
  return path;
}

function write(path: string, availableMb: number | null) {
  writeFileSync(
    path,
    availableMb === null
      ? 'MemTotal:        1000000 kB\n'
      : `MemTotal:        1000000 kB\nMemAvailable:    ${availableMb * 1024} kB\n`
  );
}

const marker = (path: string) => join(path, '..', 'stopped');

function start(path: string, extra: Record<string, string> = {}) {
  const victim = Bun.spawn(['sleep', '60']);
  victims.push(victim);
  const watchdog = Bun.spawn(['sh', SCRIPT, String(victim.pid)], {
    env: {
      ...process.env,
      WATCHDOG_MEMINFO: path,
      WATCHDOG_INTERVAL_S: '0.05',
      WATCHDOG_MIN_AVAILABLE_MB: '96',
      WATCHDOG_STRIKES: '2',
      WATCHDOG_REPORT_EVERY: '1000',
      WATCHDOG_KILL_GRACE_S: '1',
      WATCHDOG_MARKER: marker(path),
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { victim, watchdog };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('memory-watchdog.sh (SC-1269)', () => {
  test('stops the worker when available memory stays under the floor, and says why', async () => {
    const path = meminfo(40);
    const { victim, watchdog } = start(path);
    expect(await watchdog.exited).toBe(0);
    // The entrypoint turns this into a non-zero exit so Fly restarts the machine.
    expect(existsSync(marker(path))).toBe(true);
    await victim.exited;
    expect(victim.signalCode).toBe('SIGTERM');
    expect(await new Response(watchdog.stderr).text()).toContain('STOPPING worker pid');
  });

  test('leaves the worker alone while memory is above the floor', async () => {
    const path = meminfo(600);
    const { victim } = start(path);
    await Bun.sleep(400);
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(marker(path))).toBe(false);
  });

  test('a single dip is not enough: the count resets when memory recovers', async () => {
    const path = meminfo(600);
    const { victim } = start(path);
    // Each dip lasts less than one 50ms read interval, so it can hold at most
    // one low read; the recovery between them lasts several.
    for (let i = 0; i < 4; i++) {
      write(path, 40);
      await Bun.sleep(30);
      write(path, 600);
      await Bun.sleep(200);
    }
    expect(alive(victim.pid)).toBe(true);
  });

  test('an unreadable reading never stops the worker', async () => {
    const { victim, watchdog } = start(meminfo(null));
    await Bun.sleep(400);
    expect(alive(victim.pid)).toBe(true);
    victim.kill('SIGKILL');
    expect(await watchdog.exited).toBe(0);
    expect(await new Response(watchdog.stderr).text()).toContain('MemAvailable unreadable');
  });

  test('exits by itself once the worker is gone', async () => {
    const { victim, watchdog } = start(meminfo(600));
    victim.kill('SIGKILL');
    expect(await watchdog.exited).toBe(0);
  });
});

describe('the liveness ping (SC-1269)', () => {
  // The probe reads a file, so a test can make Redis answer, stop answering, or never start.
  function ping(path: string, answer: string) {
    const file = join(path, '..', 'pong');
    writeFileSync(file, answer);
    return { file, env: { WATCHDOG_PING_CMD: `cat ${file}`, WATCHDOG_PING_STRIKES: '3' } };
  }

  test('once armed, consecutive misses stop the worker and say why', async () => {
    const path = meminfo(600);
    const p = ping(path, 'PONG');
    const { victim, watchdog } = start(path, p.env);
    await Bun.sleep(300);
    expect(alive(victim.pid)).toBe(true);
    writeFileSync(p.file, '');
    expect(await watchdog.exited).toBe(0);
    expect(existsSync(marker(path))).toBe(true);
    await victim.exited;
    expect(victim.signalCode).toBe('SIGTERM');
    expect(await new Response(watchdog.stderr).text()).toContain('liveness ping missed');
  });

  test('a probe that never arms says so rather than protecting nothing in silence', async () => {
    const path = meminfo(600);
    const p = ping(path, 'NOAUTH Authentication required.');
    const { victim, watchdog } = start(path, { ...p.env, WATCHDOG_PING_UNARMED_WARN: '3' });
    await Bun.sleep(400);
    expect(alive(victim.pid)).toBe(true);
    victim.kill('SIGKILL');
    await watchdog.exited;
    expect(await new Response(watchdog.stderr).text()).toContain('liveness ping NOT ARMED');
  });

  test('an armed probe says so once', async () => {
    const path = meminfo(600);
    const p = ping(path, 'PONG');
    const { victim, watchdog } = start(path, p.env);
    await Bun.sleep(300);
    victim.kill('SIGKILL');
    await watchdog.exited;
    const out = await new Response(watchdog.stdout).text();
    expect(out.match(/liveness ping armed/g)?.length).toBe(1);
  });

  test('a Redis that never answered (still loading at boot) does not trip it', async () => {
    const path = meminfo(600);
    const p = ping(path, 'LOADING');
    const { victim } = start(path, p.env);
    await Bun.sleep(600);
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(marker(path))).toBe(false);
  });

  test('a Redis that keeps answering leaves the worker alone', async () => {
    const path = meminfo(600);
    const p = ping(path, 'PONG');
    const { victim } = start(path, p.env);
    await Bun.sleep(600);
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(marker(path))).toBe(false);
  });
});
