/**
 * SC-225 — the reconnection path itself, against a real `ioredis` 5.10.1
 * client, with name resolution under the test's control.
 *
 * The sibling file (`redis-reachability.test.ts`) pins the observation state
 * machine in isolation. This one answers the question the ticket actually
 * asked — *what does the pinned version do with `ENOTFOUND`* — by making the
 * resolver fail and then heal, and watching what the client does about it.
 *
 * **How it is possible to test at all.** `net.createConnection` accepts a
 * `lookup` option, so a connector that calls it can decide what a hostname
 * resolves to. ioredis's own `StandaloneConnector` builds its socket options
 * from `path`/`port`/`host`/`family` only and drops everything else, so the
 * hook cannot be passed through `new Redis({...})` — but `options.Connector`
 * (`Redis.js:56`) is a supported extension point, and a connector supplied
 * that way *does* control the socket options. That is the whole trick, and it
 * is why this is a real reproduction rather than a mock: the socket, the
 * `getaddrinfo ENOTFOUND` DNSException, the retry loop and the recovery are
 * all the genuine article. Only the resolver is ours.
 *
 * **What is NOT simulated, stated plainly.** The production fault was a
 * machine whose *host resolver* stopped answering for `.internal` names. This
 * test does not and cannot reproduce that condition — it cannot break Fly's
 * DNS, edit `/etc/hosts`, or corrupt a resolver's state. What it reproduces is
 * the client's behaviour *given* a name that fails to resolve, which is the
 * half the ticket asked about and the half that lives in our repo.
 *
 * **The load-bearing detail, found by reading `Redis.js:120-135`.** If the
 * connector's promise *rejects*, ioredis calls `setStatus("end")` and stops
 * for good. Production retries forever instead because `net.createConnection`
 * returns a socket that *later* emits the DNS error, so the promise resolves
 * and `stream.once("close", closeHandler)` is what runs — and `closeHandler`
 * retries while `retryStrategy` returns a number, which the default
 * `Math.min(times * 50, 2000)` always does. A connector that rejected would
 * therefore have tested the opposite behaviour to production. This one
 * resolves a real socket, exactly as the real connector does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import Redis, { type RedisOptions } from 'ioredis';
import { observeRedisReachability, type ReachabilityLogger } from '../src/redis-reachability';

/** The hostname under test. It is never really resolved — `lookup` decides. */
const HOST = 'scani-worker.internal';

/**
 * Node calls `lookup` with `{ all: true }`, so a successful answer is an
 * ARRAY of addresses, not a bare string. Returning a string yields
 * `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` — which fails in a
 * way that looks exactly like the DNS failure under test.
 */
type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

interface Harness {
  client: Redis;
  server: Server;
  /** How many times resolution has been attempted. One per connect attempt. */
  lookups: () => number;
  healDns: () => void;
  close: () => Promise<void>;
}

/**
 * A `ioredis` client whose DNS answers come from `resolves`, over a real
 * loopback server. Starts broken; `healDns()` makes the name resolve.
 */
async function harness(logger: ReachabilityLogger): Promise<{
  harness: Harness;
  current: (now?: Date) => ReturnType<ReturnType<typeof observeRedisReachability>['current']>;
}> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const port = address.port;

  let resolves = false;
  let lookups = 0;

  const lookup = (hostname: string, opts: { all?: boolean }, cb: LookupCb): void => {
    lookups += 1;
    if (resolves) {
      if (opts?.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
      else cb(null, '127.0.0.1', 4);
      return;
    }
    // The shape Node produces for a genuine resolution failure, which is what
    // `isNameResolutionError` keys on and what production logged.
    const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    err.syscall = 'getaddrinfo';
    cb(err, '', 4);
  };

  class ControlledDnsConnector {
    connecting = false;
    stream: Socket | undefined;
    firstError: Error | undefined;

    check(): boolean {
      return true;
    }

    disconnect(): void {
      this.connecting = false;
      this.stream?.destroy();
    }

    // Deliberately resolves the socket rather than rejecting on failure —
    // see the note at the top of the file. Rejecting would end the client.
    connect(): Promise<Socket> {
      this.connecting = true;
      const stream = createConnection({ host: HOST, port, lookup });
      this.stream = stream;
      stream.once('error', (err: Error) => {
        this.firstError = err;
      });
      return Promise.resolve(stream);
    }
  }

  const client = new Redis({
    host: HOST,
    port,
    lazyConnect: true,
    enableReadyCheck: false,
    // The loopback server accepts sockets but speaks no RESP. Without these
    // two, ioredis sends `INFO` / `CLIENT SETINFO` on connect and sits at
    // status `connect` forever waiting for replies, so a recovery that DID
    // happen would read as one that did not.
    disableClientInfo: true,
    maxRetriesPerRequest: null,
    // Keep the test in the tens of milliseconds. The production cadence comes
    // from the DEFAULT strategy, which is asserted separately below.
    retryStrategy: () => 20,
    Connector: ControlledDnsConnector as unknown as RedisOptions['Connector'],
  });

  const observer = observeRedisReachability(client, logger, 'test-redis');

  return {
    harness: {
      client,
      server,
      lookups: () => lookups,
      healDns: () => {
        resolves = true;
      },
      close: async () => {
        client.disconnect();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    },
    current: observer.current,
  };
}

function recordingLogger(): {
  logger: ReachabilityLogger;
  lines: Array<{ level: 'warn' | 'error' | 'info'; payload: Record<string, unknown>; msg: string }>;
} {
  const lines: Array<{
    level: 'warn' | 'error' | 'info';
    payload: Record<string, unknown>;
    msg: string;
  }> = [];
  return {
    lines,
    logger: {
      warn: (payload, msg) => lines.push({ level: 'warn', payload, msg }),
      error: (payload, msg) => lines.push({ level: 'error', payload, msg }),
      info: (payload, msg) => lines.push({ level: 'info', payload, msg }),
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ioredis 5.10.1 against a name that does not resolve', () => {
  let open: Harness | undefined;

  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  test('re-resolves on every attempt — there is no cached answer to invalidate', async () => {
    const { logger } = recordingLogger();
    const built = await harness(logger);
    open = built.harness;

    built.harness.client.connect().catch(() => {});

    // The ticket's hypothesis was that ioredis pins one bad answer and retries
    // it. If that were true the resolver would be consulted once no matter how
    // long we wait. It is consulted once per attempt.
    await waitFor(() => built.harness.lookups() >= 4);
    expect(built.harness.lookups()).toBeGreaterThanOrEqual(4);
  });

  test('never gives up on its own — the failure is unbounded, not exhausted', async () => {
    const { logger } = recordingLogger();
    const built = await harness(logger);
    open = built.harness;

    built.harness.client.connect().catch(() => {});
    await waitFor(() => built.harness.lookups() >= 6);

    // Still trying, still failing, still not 'end'. This is why the machine
    // sat broken for three hours instead of crashing and being replaced.
    expect(built.harness.client.status).not.toBe('end');
    expect(built.current().state).toBe('unreachable');
  });

  test('the observer reports it as name resolution, not as a connection blip', async () => {
    const { logger, lines } = recordingLogger();
    const built = await harness(logger);
    open = built.harness;

    built.harness.client.connect().catch(() => {});
    await waitFor(() => built.current().state === 'unreachable');

    const state = built.current();
    if (state.state !== 'unreachable') throw new Error('expected unreachable');
    expect(state.nameResolutionFailure).toBe(true);
    expect(state.lastErrorCode).toBe('ENOTFOUND');

    // Announced once, at `error` level, no matter how many times it retries.
    await waitFor(() => built.harness.lookups() >= 5);
    const announcements = lines.filter((l) => l.level === 'error');
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.msg).toContain('does not resolve from this machine');
  });

  test('recovers with no intervention once the name resolves again', async () => {
    const { logger, lines } = recordingLogger();
    const built = await harness(logger);
    open = built.harness;

    built.harness.client.connect().catch(() => {});
    await waitFor(() => built.current().state === 'unreachable');

    // Nothing is done to the client. Only the world changes.
    built.harness.healDns();

    await waitFor(() => built.current().state === 'ok');
    expect(built.harness.client.status).toBe('ready');

    const recovery = lines.filter((l) => l.level === 'info');
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.msg).toBe('Redis reachable again');
    expect(recovery[0]?.payload.unreachableForMs).toBeGreaterThanOrEqual(0);
  });

  test('an error listener is attached — the old behaviour was console spam', async () => {
    const { logger } = recordingLogger();
    const built = await harness(logger);
    open = built.harness;

    // `Redis.js:532` only prints `[ioredis] Unhandled error event:` when
    // `listeners('error').length === 0`. Before SC-225 nothing listened, so
    // every failure went to stdout unstructured and nothing could read the
    // state. This assertion fails on that old behaviour.
    expect(built.harness.client.listeners('error').length).toBeGreaterThan(0);
  });
});

describe("ioredis 5.10.1's default retry cadence", () => {
  test('the default strategy always returns a number, so it retries forever', () => {
    // Read off `RedisOptions.js:11-12`. Reimplemented here rather than
    // imported because it is a default we depend on and do not control: if a
    // future bump makes it give up, or changes the ceiling away from the ~2s
    // seen in production, this is the test that notices.
    const defaultStrategy = (times: number): number => Math.min(times * 50, 2000);

    expect(defaultStrategy(1)).toBe(50);
    expect(defaultStrategy(40)).toBe(2000);
    // The observed production cadence, after ~40 attempts, forever.
    expect(defaultStrategy(100_000)).toBe(2000);
    expect(new Redis({ lazyConnect: true }).options.retryStrategy?.(100_000)).toBe(2000);
  });
});
