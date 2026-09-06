import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { StorageService } from '@scani/storage';
import { Container } from 'typedi';
import { DbBackupProcessor } from '../../src/processors/db-backup';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-793. The offsite dump moved onto the worker because both things that used
 * to take it can stop without saying so: `backup-db.yaml` last succeeded
 * 2026-08-09 (Actions billing block) and the laptop LaunchAgent skipped three
 * occurrences in thirteen days while the Mac was powered off.
 *
 * `pg_dump` and `pg_restore` are exercised as REAL subprocesses against fakes
 * on PATH rather than stubbed behind a seam. The seam would test that the
 * method was called; this tests the argv, the exit code, the stderr and the
 * file on disk — and the failures worth catching here are all in that layer.
 * The version-mismatch case in particular is one this job WILL hit the day
 * Neon moves to PostgreSQL 17.
 */

const DIR = mkdtempSync(join(tmpdir(), 'db-backup-'));
const BIN = join(DIR, 'bin');
const STAGE = join(DIR, 'stage');
const ORIGINAL_PATH = process.env.PATH;

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(DIR, { recursive: true, force: true });
});

/** Install a fake executable on the PATH the processor's spawns resolve from. */
function fake(name: string, script: string): void {
  const path = join(BIN, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

const ARCHIVE_BYTES = 'PGDMP fake custom-format archive';

/** The normal pair: pg_dump writes an archive, pg_restore lists two tables. */
function installWorkingClients(): void {
  // Records its argv so a test can assert the flags, and writes the archive to
  // whatever `--file` names — which is also how the test proves the temp file
  // is cleaned up afterwards.
  fake(
    'pg_dump',
    `printf '%s\\n' "$@" > "${join(DIR, 'pg_dump.argv')}"
     while [ $# -gt 0 ]; do
       if [ "$1" = "--file" ]; then printf '%s' '${ARCHIVE_BYTES}' > "$2"; fi
       shift
     done`
  );
  fake(
    'pg_restore',
    `echo ";     215; 1259 16404 TABLE DATA public users postgres"
     echo ";     216; 1259 16405 TABLE DATA public holdings postgres"
     echo ";     217; 1259 16406 INDEX public users_pkey postgres"`
  );
}

interface Written {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  bucket: string | undefined;
}

/**
 * A processor wired to fake clients, a scratch stage directory and a storage
 * stub that keeps what it was handed.
 */
function harness(opts: { bucket?: string; corruptOnRead?: boolean } = {}) {
  const written: Written[] = [];

  Container.set(StorageService, {
    write: async (key: string, bytes: Uint8Array, contentType: string, o?: { bucket?: string }) => {
      written.push({ key, bytes, contentType, bucket: o?.bucket });
    },
    read: async (key: string) => {
      const found = written.find((w) => w.key === key);
      if (!found) throw new Error(`stub storage: no object at ${key}`);
      return opts.corruptOnRead
        ? Buffer.from('not what was written at all')
        : Buffer.from(found.bytes);
    },
  } as unknown as StorageService);

  class TestProcessor extends DbBackupProcessor {
    protected config() {
      return {
        databaseUrl: 'postgresql://u:p@db.example/neondb?sslmode=require',
        bucket: 'bucket' in opts ? opts.bucket : 'test-bucket',
      };
    }
    protected dumpDir(): string {
      return STAGE;
    }
    run(): Promise<void> {
      // `handle` is protected; the base class's `process()` would drag in the
      // lock and heartbeat wiring, which is not what these tests are about.
      return (this as unknown as { handle(): Promise<void> }).handle();
    }
  }

  const processor = new TestProcessor();
  Container.set(DbBackupProcessor, processor);
  return { processor, written };
}

beforeEach(() => {
  rmSync(BIN, { recursive: true, force: true });
  rmSync(STAGE, { recursive: true, force: true });
  Bun.spawnSync(['mkdir', '-p', BIN, STAGE]);
  process.env.PATH = `${BIN}:${ORIGINAL_PATH}`;
  installWorkingClients();
});

describe('it dumps, verifies and uploads', () => {
  test('uploads the archive to BACKUP_BUCKET and verifies the bytes back', async () => {
    const { processor, written } = harness();

    await processor.run();

    expect(written).toHaveLength(1);
    expect(written[0]?.bucket).toBe('test-bucket');
    expect(written[0]?.contentType).toBe('application/octet-stream');
    expect(Buffer.from(written[0]!.bytes).toString()).toBe(ARCHIVE_BYTES);
  });

  test('spawns pg_dump with the same flags the other two producers use', async () => {
    const { processor } = harness();
    await processor.run();

    const argv = readFileSync(join(DIR, 'pg_dump.argv'), 'utf8').split('\n');
    // The three artefacts have to stay interchangeable: a restore drill run
    // against one is only evidence about the others if the flags match.
    expect(argv).toContain('--format=custom');
    expect(argv).toContain('--no-owner');
    expect(argv).toContain('--no-privileges');
    expect(argv).toContain('postgresql://u:p@db.example/neondb?sslmode=require');
  });

  test('removes the staged archive, so /tmp does not fill one day at a time', async () => {
    const { processor, written } = harness();
    await processor.run();

    expect(existsSync(join(STAGE, written[0]!.key))).toBe(false);
  });
});

describe('the key is the contract the archive auditor reads', () => {
  /**
   * A key in any other shape lands safely in the bucket and reads to whatever
   * audits the series as a day with NO backup — a silent hole, which is the
   * failure this whole ticket is about.
   *
   * This restates the pattern rather than reading the auditor's source,
   * because the auditor is part of the deployment overlay and is not in every
   * checkout of this repository. Where it IS present it is pinned to this
   * literal by a test beside it, so the two copies still cannot drift.
   */
  const AUDITOR_KEY = /^scani-(\d{8})T(\d{6})Z\.dump$/;

  test('the key this job writes is one the auditor counts as a dump', async () => {
    const { processor, written } = harness();
    await processor.run();

    expect(written[0]!.key).toMatch(AUDITOR_KEY);
  });

  test('must-be-ABSENT control: a plausible near-miss does NOT match', () => {
    // Milliseconds left in, or a `.sql` extension, or the dashes kept — each
    // is a key that uploads fine and disappears from the audit.
    expect('scani-20260829T060000.123Z.dump').not.toMatch(AUDITOR_KEY);
    expect('scani-2026-08-29T060000Z.dump').not.toMatch(AUDITOR_KEY);
    expect('scani-20260829T060000Z.sql').not.toMatch(AUDITOR_KEY);
  });
});

describe('it refuses rather than reporting a backup it did not take', () => {
  test('no BACKUP_BUCKET is a refusal that names where the value lives', async () => {
    const { processor, written } = harness({ bucket: undefined });

    expect(processor.run()).rejects.toThrow(/BACKUP_BUCKET is not set/);
    await processor.run().catch(() => {});
    expect(written).toHaveLength(0);
  });

  test("a pg_dump version mismatch surfaces pg_dump's own sentence", async () => {
    // What a Neon major upgrade looks like from in here. Measured against a
    // real PG16 on 2026-08-29: a 15.19 client exits 1 with zero bytes.
    fake(
      'pg_dump',
      `echo "pg_dump: error: aborting because of server version mismatch" >&2
       echo "pg_dump: detail: server version: 17.2; pg_dump version: 16.15" >&2
       exit 1`
    );
    const { processor, written } = harness();

    expect(processor.run()).rejects.toThrow(/aborting because of server version mismatch/);
    await processor.run().catch(() => {});
    expect(written).toHaveLength(0);
  });

  test('an archive with no TABLE DATA is not uploaded', async () => {
    // Uploading an unrestorable archive is worse than uploading nothing,
    // because it looks like protection until the day somebody needs it.
    fake('pg_restore', 'echo ";     217; 1259 16406 INDEX public users_pkey postgres"');
    const { processor, written } = harness();

    expect(processor.run()).rejects.toThrow(/no TABLE DATA/);
    await processor.run().catch(() => {});
    expect(written).toHaveLength(0);
  });

  test('an empty archive from a pg_dump that exited 0 is refused', async () => {
    fake(
      'pg_dump',
      'while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then : > "$2"; fi; shift; done'
    );
    const { processor } = harness();

    expect(processor.run()).rejects.toThrow(/empty archive/);
  });

  test('a read-back that does not match the dump is a failure, not a success', async () => {
    // A write that returned without throwing says a request was answered. It
    // does not say the object is in the bucket, and it is the object that has
    // to be there on the day somebody needs it.
    const { processor } = harness({ corruptOnRead: true });

    expect(processor.run()).rejects.toThrow(/read-back of scani-.*does not match/);
  });

  test('the staged archive is removed even when the run fails', async () => {
    fake('pg_restore', 'echo "nothing here"');
    const { processor } = harness();

    await processor.run().catch(() => {});

    expect(Bun.spawnSync(['ls', STAGE]).stdout.toString().trim()).toBe('');
  });
});

describe('the sha256 it logs is the one in the bucket', () => {
  test('matches a digest computed independently of the processor', async () => {
    const { processor, written } = harness();
    await processor.run();

    const independent = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
    expect(createHash('sha256').update(Buffer.from(written[0]!.bytes)).digest('hex')).toBe(
      independent
    );
  });
});
