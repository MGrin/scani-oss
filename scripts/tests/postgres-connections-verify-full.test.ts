import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SC-784. Every Postgres connection the services open verifies the server, and
 * this file is what goes red when one stops.
 *
 * Neon emits `sslmode=require`. Measured against a server with an untrusted
 * certificate: postgres.js `ssl: 'require'` and libpq `sslmode=require` both
 * connected, and pg 8's `require` refused only because it is an alias for
 * verify-full until pg 9. So a connection site that reads the URL's sslmode
 * itself, or hands the raw URL to a driver, is a connection that may verify
 * nothing — and it works perfectly, which is why this is a scan and not a
 * hope.
 *
 * The rule: a file under a service or package `src/` that opens a connection
 * (`postgres(`, `new Pool(`, a BullMQ `connectionString`, or `pg_dump`) must go
 * through `@scani/config`'s helpers, and no such file may name `'require'` as
 * an ssl value.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

const OPENERS: [label: string, pattern: RegExp, helper: RegExp][] = [
  ['postgres.js client', /\bpostgres\(/, /\bpostgresJsSsl\(/],
  ['pg Pool', /\bnew Pool\(/, /\bverifiedPgConnectionString\(/],
  ['BullMQ connectionString', /\bconnectionString:/, /\bverifiedPgConnectionString\(/],
  ['pg_dump', /'pg_dump'/, /\bverifiedLibpqConnectionString\(/],
];

function sourceFiles(): string[] {
  const out = spawnSync(
    'git',
    // `:(glob)` so `**/` also matches zero directories; a plain pathspec skips
    // every file sitting directly under `src/`, connection.ts among them.
    ['ls-files', ':(glob)packages/*/*/src/**/*.ts', ':(glob)apps/backend/*/src/**/*.ts'],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (out.status !== 0) throw new Error(`NOTHING WAS SCANNED: git ls-files failed: ${out.stderr}`);
  return out.stdout.split('\n').filter((f) => f.length > 0 && !f.endsWith('.test.ts'));
}

/** Code only: a comment explaining why `'require'` is wrong must not trip the ban. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('SC-784 — every Postgres connection verifies the server', () => {
  const files = sourceFiles();
  const sites = files.flatMap((file) => {
    const text = code(readFileSync(join(ROOT, file), 'utf8'));
    return OPENERS.filter(([, opens]) => opens.test(text)).map(([label, , helper]) => ({
      file,
      label,
      text,
      helper,
    }));
  });

  test('the scan reaches the connection sites it exists for', () => {
    // Control: an empty or mis-rooted scan would pass every test below.
    const found = new Set(sites.map((s) => s.file));
    for (const file of [
      'packages/infra/db/src/connection.ts',
      'packages/infra/db/src/migrate.ts',
      'apps/backend/data-provider/src/db/connection.ts',
      'packages/infra/queue/src/migrate.ts',
      'packages/infra/queue/src/locks/postgres-resource-lock.ts',
      'packages/infra/queue/src/consumer/worker-client.ts',
      'packages/infra/queue/src/producer/queue-client.ts',
      'apps/backend/worker/src/processors/db-backup.ts',
    ]) {
      expect(found.has(file)).toBe(true);
    }
  });

  test('every site goes through the verifying helper', () => {
    const bypass = sites.filter((s) => !s.helper.test(s.text)).map((s) => `${s.file} (${s.label})`);
    expect(bypass).toEqual([]);
  });

  test("no connection site names 'require' as an ssl value", () => {
    const offenders = sites
      .filter((s) =>
        /ssl\w*\s*[:=]\s*'require'|return\s+'require'|'require'\s+as\s+const/.test(s.text)
      )
      .map((s) => s.file);
    expect([...new Set(offenders)]).toEqual([]);
  });

  test('the control fires: a site reading sslmode into require is caught', () => {
    const planted = `const sslMode = (() => { return 'require' as const; })();\nconst c = postgres(url, { ssl: sslMode });`;
    expect(/\bpostgres\(/.test(planted)).toBe(true);
    expect(/\bpostgresJsSsl\(/.test(planted)).toBe(false);
    expect(/return\s+'require'|'require'\s+as\s+const/.test(planted)).toBe(true);
  });
});
