/**
 * SC-1269. The watchdog runs for real against a `sleep` standing in for the
 * worker and a file standing in for /proc/meminfo, so what is asserted is
 * whether the process survives.
 *
 * NO TEST HERE WAITS A FIXED TIME FOR THE WATCHDOG TO DO SOMETHING (SC-1308).
 * `Bun.sleep(400)` bet that another process would get through a few 50ms reads
 * in that window. Under gate load it did not, and the tests went red as
 * ASSERTIONS that isolate green — which reads as contention and is not. Each
 * one now waits on the watchdog's own evidence of having read — what it
 * printed, or one history line per read — with a ceiling that fails naming
 * what never happened. The ceiling is the arm that keeps them able to fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'memory-watchdog.sh');
const CEILING_MS = 10_000;
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

/** A meminfo the watchdog can only read when the test hands it a value. */
function pipe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
  dirs.push(dir);
  const path = join(dir, 'meminfo');
  const made = Bun.spawnSync(['mkfifo', path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  return path;
}

/**
 * Hands the watchdog one reading per value, and waits for its history line
 * before the next. Without that wait, a write could reach a read that is still
 * open and both values would land in one read.
 */
async function feed(fifo: string, values: number[]) {
  for (const mb of values) {
    const before = reads(fifo);
    const text = `MemTotal:        1000000 kB\nMemAvailable:    ${mb * 1024} kB\n`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`within ${CEILING_MS}ms the watchdog never read ${mb}MB`)),
        CEILING_MS
      );
    });
    try {
      await Promise.race([writeFile(fifo, text), ceiling]);
    } catch (e) {
      // Open the read end ourselves so the stranded write can finish.
      closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
      throw e;
    } finally {
      clearTimeout(timer);
    }
    await until(`recorded reading ${mb}MB`, () => reads(fifo) > before);
  }
}

const recorded = (path: string) =>
  [...read(history(path)).matchAll(/^\S+Z available=(\d+)MB/gm)].map((m) => Number(m[1]));

/** Collects a pipe as it arrives, so a test can wait on what has been said so far. */
function tap(stream: ReadableStream<Uint8Array>) {
  let text = '';
  const decoder = new TextDecoder();
  const done = (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    return text;
  })();
  return { now: () => text, done };
}

async function until(what: string, ok: () => boolean) {
  const deadline = Date.now() + CEILING_MS;
  while (!ok()) {
    if (Date.now() > deadline)
      throw new Error(`within ${CEILING_MS}ms the watchdog never: ${what}`);
    await Bun.sleep(20);
  }
}

const history = (path: string) => join(path, '..', 'history.log');
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const reads = (path: string) =>
  read(history(path))
    .split('\n')
    .filter((l) => /available=/.test(l)).length;

/** One history line per read is the watchdog's own count of how often it has looked. */
const counted = { WATCHDOG_HISTORY_EVERY: '1' };
const afterReads = (path: string, n: number) =>
  until(`read memory ${n} times`, () => reads(path) >= n);

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
      WATCHDOG_HISTORY_FILE: history(path),
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { victim, watchdog, out: tap(watchdog.stdout), err: tap(watchdog.stderr) };
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
    const { victim, watchdog, err } = start(path);
    expect(await watchdog.exited).toBe(0);
    // The entrypoint turns this into a non-zero exit so Fly restarts the machine.
    expect(existsSync(marker(path))).toBe(true);
    await victim.exited;
    expect(victim.signalCode).toBe('SIGTERM');
    expect(await err.done).toContain('STOPPING worker pid');
  });

  // 96 MB was too late: on 2026-09-21 the box went from 240 MB to 0 inside one
  // backfill chunk, and at 0 the watchdog's own TERM/KILL loop could not run
  // for about four minutes (SC-1283).
  test('the default floor is 160 MB', async () => {
    const low = meminfo(150);
    const stopped = start(low, { WATCHDOG_MIN_AVAILABLE_MB: '' });
    expect(await stopped.watchdog.exited).toBe(0);
    expect(await stopped.err.done).toContain('under 160MB');

    const high = meminfo(200);
    const above = start(high, { WATCHDOG_MIN_AVAILABLE_MB: '', ...counted });
    await afterReads(high, 4);
    expect(alive(above.victim.pid)).toBe(true);
  });

  test('leaves the worker alone while memory is above the floor', async () => {
    const path = meminfo(600);
    const { victim } = start(path, counted);
    await afterReads(path, 4);
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(marker(path))).toBe(false);
  });

  // These two feed the watchdog through a FIFO, so every read gets exactly the
  // value the test hands it. A timed dip could span two reads under load and
  // read as two strikes (SC-1308, recurred on Verifier #668).
  test('a single dip is not enough: the count resets when memory recovers', async () => {
    const fifo = pipe();
    const { victim } = start(fifo, counted);
    for (let i = 0; i < 4; i++) await feed(fifo, [40, 600]);
    // One more read, so every reading above has been acted on.
    await feed(fifo, [600]);
    expect(recorded(fifo)).toEqual([40, 600, 40, 600, 40, 600, 40, 600, 600]);
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(marker(fifo))).toBe(false);
  });

  test('two low reads in a row do stop it (the control for the single dip)', async () => {
    const fifo = pipe();
    const { victim, watchdog } = start(fifo, counted);
    await feed(fifo, [600, 40, 40]);
    expect(recorded(fifo)).toEqual([600, 40, 40]);
    expect(await watchdog.exited).toBe(0);
    await victim.exited;
    expect(victim.signalCode).toBe('SIGTERM');
  });

  test('an unreadable reading never stops the worker', async () => {
    const { victim, watchdog, err } = start(meminfo(null));
    await until('reported MemAvailable unreadable', () =>
      err.now().includes('MemAvailable unreadable')
    );
    expect(alive(victim.pid)).toBe(true);
    victim.kill('SIGKILL');
    expect(await watchdog.exited).toBe(0);
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
    const { victim, watchdog, out, err } = start(path, p.env);
    await until('armed the liveness ping', () => out.now().includes('liveness ping armed'));
    expect(alive(victim.pid)).toBe(true);
    writeFileSync(p.file, '');
    expect(await watchdog.exited).toBe(0);
    expect(existsSync(marker(path))).toBe(true);
    await victim.exited;
    expect(victim.signalCode).toBe('SIGTERM');
    expect(await err.done).toContain('liveness ping missed');
  });

  test('a probe that never arms says so rather than protecting nothing in silence', async () => {
    const path = meminfo(600);
    const p = ping(path, 'NOAUTH Authentication required.');
    const { victim, watchdog, err } = start(path, { ...p.env, WATCHDOG_PING_UNARMED_WARN: '3' });
    await until('said the ping is NOT ARMED', () => err.now().includes('liveness ping NOT ARMED'));
    expect(alive(victim.pid)).toBe(true);
    victim.kill('SIGKILL');
    await watchdog.exited;
  });

  test('an armed probe says so once', async () => {
    const path = meminfo(600);
    const p = ping(path, 'PONG');
    const { victim, watchdog, out } = start(path, { ...p.env, ...counted });
    await until('armed the liveness ping', () => out.now().includes('liveness ping armed'));
    // Several reads AFTER arming, or "once" is only a claim about one read.
    const armedAt = reads(path);
    await afterReads(path, armedAt + 4);
    victim.kill('SIGKILL');
    await watchdog.exited;
    expect((await out.done).match(/liveness ping armed/g)?.length).toBe(1);
  });

  test('a Redis that never answered (still loading at boot) does not trip it', async () => {
    const path = meminfo(600);
    const p = ping(path, 'LOADING');
    const { victim } = start(path, { ...p.env, ...counted });
    await afterReads(path, 8);
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(marker(path))).toBe(false);
  });

  test('a Redis that keeps answering leaves the worker alone', async () => {
    const path = meminfo(600);
    const p = ping(path, 'PONG');
    const { victim } = start(path, { ...p.env, ...counted });
    await afterReads(path, 8);
    expect(alive(victim.pid)).toBe(true);
    expect(existsSync(marker(path))).toBe(false);
  });
});

describe('the memory history (SC-1269)', () => {
  test('records available memory and each watched process, one line per period', async () => {
    const path = meminfo(600);
    const other = Bun.spawn(['sleep', '60']);
    victims.push(other);
    const { victim, watchdog } = start(path, { ...counted, WATCHDOG_ALSO_PID: String(other.pid) });
    await afterReads(path, 3);
    victim.kill('SIGKILL');
    await watchdog.exited;
    const lines = read(history(path)).trim().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ available=600MB worker_rss=\d*MB other_rss=\d*MB$/
    );
  });

  test('a stop is written to the history, so it survives the restart it causes', async () => {
    const path = meminfo(40);
    const { watchdog } = start(path);
    await watchdog.exited;
    expect(read(history(path))).toContain('STOPPING: available=40MB');
  });

  test('rotates at the size cap rather than growing without bound', async () => {
    const path = meminfo(600);
    writeFileSync(history(path), 'x'.repeat(2048));
    const { victim, watchdog } = start(path, { ...counted, WATCHDOG_HISTORY_MAX_KB: '2' });
    await until('rotated the history at its cap', () => existsSync(`${history(path)}.1`));
    victim.kill('SIGKILL');
    await watchdog.exited;
    expect(existsSync(`${history(path)}.1`)).toBe(true);
    expect(read(history(path)).length).toBeLessThan(2048);
  });
});
