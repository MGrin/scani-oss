/**
 * SC-1440: postgres.js over a TLS-wrapped JS socket keeps every byte it reads
 * on Bun, and `postgresJsTls` avoids it by opening TLS directly.
 *
 * A direct-TLS proxy in front of the test database stands in for Neon. Clients
 * run in child processes: each needs its own trust store (`NODE_EXTRA_CA_CERTS`
 * is read at startup) and its own memory reading. The wrapped client is the
 * control: if this Bun stops leaking it goes red, and the workaround can go.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

const PKG = join(import.meta.dir, '..');
const CHILD = `
import postgres from 'postgres';
import { postgresJsSsl } from '@scani/config';
import { postgresJsTls } from '@scani/config/postgres-direct-tls';
const [mode, url] = [process.env.MODE, process.env.URL];
const opts = mode === 'fixed' ? { ...postgresJsTls(url, postgresJsSsl(url)) } : { ssl: 'verify-full', sslnegotiation: 'direct' };
const sql = postgres(url, { ...opts, max: 2, onnotice: () => {} });
const out = { socketHook: typeof opts.socket === 'function' };
out.tx = await sql.begin(async (t) => {
  await t\`create temp table sc1440 (n int)\`;
  await t\`insert into sc1440 values (41), (1)\`;
  return (await t\`select sum(n)::int as s from sc1440\`)[0].s;
});
out.notified = await new Promise(async (resolve) => {
  const timer = setTimeout(() => resolve(null), 5000);
  await sql.listen('sc1440', (p) => { clearTimeout(timer); resolve(p); });
  await sql.notify('sc1440', 'hello');
});
const ext = () => { Bun.gc(true); return process.memoryUsage().external; };
const before = ext();
for (let i = 0; i < 16; i++) await sql\`select repeat('x', 1000) from generate_series(1, 5000)\`;
out.grownMB = Math.round((ext() - before) / 1048576);
console.log(JSON.stringify(out));
await sql.end();
process.exit(0);
`;

let dir: string;
let server: tls.Server;
let url: string;

async function runChild(mode: 'wrapped' | 'fixed', trust: boolean) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MODE: mode,
    URL: url,
  };
  if (trust) env.NODE_EXTRA_CA_CERTS = join(dir, 'cert.pem');
  else delete env.NODE_EXTRA_CA_CERTS;
  // Async: the proxy lives in this process, so a blocking spawn would starve it.
  const child = Bun.spawn(['bun', '-e', CHILD], {
    cwd: PKG,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split('\n').find((l) => l.startsWith('{'));
  return { exitCode, out: line ? JSON.parse(line) : null, stderr };
}

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? '');
  dir = mkdtempSync(join(tmpdir(), 'sc1440-'));
  const cert = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stderr: 'pipe' }
  );
  if (cert.exitCode !== 0)
    throw new Error(`openssl could not make a test certificate: ${cert.stderr}`);
  server = tls.createServer(
    {
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem')),
      ALPNProtocols: ['postgresql'],
    },
    (client) => {
      const pg = net.connect(Number(target.port || 5432), target.hostname);
      client.pipe(pg).pipe(client);
      client.on('error', () => pg.destroy());
      pg.on('error', () => client.destroy());
    }
  );
  await new Promise<void>((r) => server.listen(0, 'localhost', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  url = `postgres://${target.username}:${target.password}@localhost:${port}${target.pathname}?sslmode=require&sslnegotiation=direct`;
});

afterAll(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('SC-1440 — postgres.js TLS keeps no copy of what it reads', () => {
  test('CONTROL: a TLS-wrapped JS socket keeps every reply on this Bun', async () => {
    const r = await runChild('wrapped', true);
    expect(r.out, r.stderr).not.toBeNull();
    expect(r.out.grownMB).toBeGreaterThan(40);
  });

  test('postgresJsTls opens TLS directly and stays flat over the same 80 MB', async () => {
    const r = await runChild('fixed', true);
    expect(r.out, r.stderr).not.toBeNull();
    expect(r.out.socketHook).toBe(true);
    expect(r.out.grownMB).toBeLessThan(15);
  });

  test('transactions and LISTEN/NOTIFY still work over the direct socket', async () => {
    const r = await runChild('fixed', true);
    expect(r.out?.tx).toBe(42);
    expect(r.out?.notified).toBe('hello');
  });

  test('the certificate is still verified: an untrusted server is refused', async () => {
    const r = await runChild('fixed', false);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toBeNull();
    expect(r.stderr).toMatch(/SELF_SIGNED|self.signed|certificate/i);
  });
});
