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

function start(path: string) {
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
