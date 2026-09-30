/**
 * SC-1442: a session advisory lock taken through a connection pooler cannot be
 * released: the unlock reaches a different server connection. The lock stays
 * held, and every later caller SKIPS, which reads as a quiet user rather than
 * an error. Measured on Neon's pooler: the rollup ran its first 30-day chunk
 * and skipped the other eleven. So a pooler URL is refused at the lock, loudly.
 *
 * Run in a child process because the connection module reads DATABASE_URL
 * when it loads.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const PKG = join(import.meta.dir, '..');
const CHILD = `
import { withAdvisoryLock } from './src/advisory-lock';
try {
  await withAdvisoryLock('sc1442', async () => 1);
  console.log('RAN');
} catch (e) {
  console.log('ERR ' + (e instanceof Error ? e.message : String(e)));
}
process.exit(0);
`;

async function lockWith(databaseUrl: string): Promise<string> {
  const child = Bun.spawn(['bun', '-e', CHILD], {
    cwd: PKG,
    env: {
      ...(process.env as Record<string, string>),
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return out.split('\n').find((l) => l.startsWith('ERR') || l === 'RAN') ?? out;
}

describe('SC-1442 — a session lock refuses a pooler host', () => {
  test('withAdvisoryLock through a Neon pooler host is refused before any connection', async () => {
    const out = await lockWith('postgresql://u:p@ep-x-pooler.aws.neon.tech/db?sslmode=require');
    expect(out).toMatch(/^ERR Session advisory lock refused/);
  });

  test('CONTROL: a direct host is not refused by this check (it fails to connect instead)', async () => {
    const out = await lockWith('postgres://u:p@127.0.0.1:1/db?sslmode=disable');
    expect(out).toMatch(/^ERR /);
    expect(out).not.toMatch(/Session advisory lock refused/);
  });
});
