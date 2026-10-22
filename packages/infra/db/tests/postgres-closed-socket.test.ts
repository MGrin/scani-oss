import { describe, expect, test } from 'bun:test';

/**
 * SC-1761 (and SC-1738 before it). postgres.js 3.4.9 sets `socket = null` in
 * `closed()` and `nextWrite()` dereferences it unguarded, so a write on a
 * connection whose backend died throws
 * `null is not an object (evaluating 'socket.write')` from a socket handler:
 * an uncaughtException no `await` can catch. A RESERVED connection is pinned,
 * so the pool cannot rotate the dead one away, and the next query on it is the
 * write (upstream porsager/postgres#1208). The worker's job lock reserves one
 * per lock (`postgres-job-lock.ts`), and Neon's suspend terminates its backend
 * ("terminating connection due to administrator command").
 *
 * The scenario runs in a child process: an uncaughtException there is an exit
 * code and a stderr line, where in this process it would be a crashed runner.
 */
const SCENARIO = `
import postgres from 'postgres';
const url = process.env.DATABASE_URL;
const sql = postgres(url, { max: 2, onnotice: () => {} });
const killer = postgres(url, { max: 1, onnotice: () => {} });
const reserved = await sql.reserve();
const [{ pid }] = await reserved\`select pg_backend_pid() as pid\`;
await killer\`select pg_terminate_backend(\${pid})\`;
const settle = (p) => Promise.race([
  p.then(() => 'resolved', (e) => 'rejected:' + (e.code ?? e.message)),
  new Promise((r) => setTimeout(() => r('hung'), 5000)),
]);
const first = await settle(reserved\`select 1\`);
const second = await settle(reserved\`select 1\`);
await new Promise((r) => setTimeout(r, 500));
const third = await settle(reserved\`select 1\`);
console.log('RESULT ' + JSON.stringify({ first, second, third }));
reserved.release();
await Promise.all([sql.end({ timeout: 1 }), killer.end({ timeout: 1 })]);
`;

function runScenario() {
  const p = Bun.spawnSync(['bun', '-e', SCENARIO], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env },
    timeout: 30_000,
  });
  const out = p.stdout.toString();
  const err = p.stderr.toString();
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  return {
    code: p.exitCode,
    err,
    result: line
      ? (JSON.parse(line.slice(7)) as { first: string; second: string; third: string })
      : null,
  };
}

describe('a reserved connection whose backend died (SC-1761)', () => {
  test('the next queries reject CONNECTION_CLOSED; the process does not throw', () => {
    const r = runScenario();
    expect(r.err).not.toContain("evaluating 'socket.write'");
    expect(r.code).toBe(0);
    // How the kill reaches the client decides the first code: CONNECTION_CLOSED
    // on macOS, ECONNRESET on CI's Linux Postgres 16 (build #1972). Either is
    // a rejection, which is all this one owes.
    expect(r.result?.first).toStartWith('rejected:');
    // Each later query must SETTLE, not vanish. Which way it would vanish
    // depends on when the close lands, and both orders occur on Linux CI:
    // queued between the socket's error and its close (`second`), or sent
    // after the close onto a null socket (`third`, production's throw).
    expect(r.result?.second).toBe('rejected:CONNECTION_CLOSED');
    expect(r.result?.third).toBe('rejected:CONNECTION_CLOSED');
  });
});
