import { afterEach, describe, expect, test } from 'bun:test';
import {
  serveWorkerWake,
  signWorkerWake,
  verifyWorkerWake,
  WORKER_WAKE_PATH,
  WORKER_WAKE_TIMEOUT_MS,
  WorkerWakeClient,
} from '../../src/wake/worker-wake';

/**
 * SC-1144. The api pings the worker after a user enqueues, so a job added
 * while a scale-to-zero Postgres is suspended — and the worker's LISTEN is
 * down with it — starts at once instead of at the worker's next poll.
 *
 * The ping is an optimisation and never a dependency: every arm below that
 * fails the wake asserts `ping()` still RESOLVES, and promptly, because it
 * runs after an enqueue a user is waiting on.
 */

const SECRET = 'test_wake_secret_at_least_32_characters_long';

const servers: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
});

function serve(onWake: () => void) {
  const server = serveWorkerWake({ port: 0, hostname: '127.0.0.1', secret: SECRET, onWake });
  servers.push(server);
  return server;
}

function client(url: string | undefined, secret: string | undefined) {
  const c = new WorkerWakeClient();
  c.configure({ url, secret });
  return c;
}

describe('the wake signature', () => {
  test('a fresh signature from the shared secret verifies', () => {
    const now = Date.now();
    expect(verifyWorkerWake(SECRET, new Headers(signWorkerWake(SECRET, now)), now)).toBe(true);
  });

  test('another secret, a stale timestamp and a missing header are all refused', () => {
    const now = Date.now();
    const other = new Headers(signWorkerWake('another_secret_of_at_least_32_characters', now));
    const stale = new Headers(signWorkerWake(SECRET, now - 60_000));
    expect(verifyWorkerWake(SECRET, other, now)).toBe(false);
    expect(verifyWorkerWake(SECRET, stale, now)).toBe(false);
    expect(verifyWorkerWake(SECRET, new Headers(), now)).toBe(false);
  });
});

describe('the wake endpoint', () => {
  test('a signed POST wakes the worker; an unsigned one is refused and wakes nothing', async () => {
    let wakes = 0;
    const server = serve(() => wakes++);
    const url = `http://127.0.0.1:${server.port}${WORKER_WAKE_PATH}`;

    const unsigned = await fetch(url, { method: 'POST' });
    expect(unsigned.status).toBe(401);
    expect(wakes).toBe(0);

    const signed = await fetch(url, {
      method: 'POST',
      headers: signWorkerWake(SECRET, Date.now()),
    });
    expect(signed.status).toBe(204);
    expect(wakes).toBe(1);
  });

  test('any other route is not found', async () => {
    const server = serve(() => undefined);
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: signWorkerWake(SECRET, Date.now()),
    });
    expect(res.status).toBe(404);
  });
});

describe('the wake client', () => {
  test('reaches the endpoint and reports the worker woken', async () => {
    let wakes = 0;
    const server = serve(() => wakes++);
    expect(await client(`http://127.0.0.1:${server.port}`, SECRET).ping()).toBe('woken');
    expect(wakes).toBe(1);
  });

  // Self-host: a single-machine stack has no 6PN and its Postgres never
  // suspends, so nothing is configured and the ping must not try anything.
  test('with no URL or no secret it is a no-op, not an error', async () => {
    expect(await client(undefined, SECRET).ping()).toBe('unconfigured');
    expect(await client('http://127.0.0.1:1', undefined).ping()).toBe('unconfigured');
  });

  test('a refused signature resolves as failed', async () => {
    let wakes = 0;
    const server = serve(() => wakes++);
    const wrong = client(
      `http://127.0.0.1:${server.port}`,
      'another_secret_of_at_least_32_characters'
    );
    expect(await wrong.ping()).toBe('failed');
    expect(wakes).toBe(0);
  });

  test('nothing listening resolves as failed', async () => {
    const server = serve(() => undefined);
    const port = server.port;
    server.stop();
    expect(await client(`http://127.0.0.1:${port}`, SECRET).ping()).toBe('failed');
  });

  test('an endpoint that never answers resolves as failed within the bound', async () => {
    // Accepts the connection and never responds — a black-holed worker.
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    });
    servers.push({ stop: () => silent.stop(true) });
    const started = Date.now();
    expect(await client(`http://127.0.0.1:${silent.port}`, SECRET).ping()).toBe('failed');
    const took = Date.now() - started;
    // It waited for the bound rather than failing on something else, and no
    // longer than the bound plus scheduling slack.
    expect(took).toBeGreaterThanOrEqual(WORKER_WAKE_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(WORKER_WAKE_TIMEOUT_MS + 2_000);
  });
});
