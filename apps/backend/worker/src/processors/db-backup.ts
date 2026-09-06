import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { DB_BACKUP_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { StorageService } from '@scani/storage';
import { Container, Service } from 'typedi';
import { loadEnv } from '../config/env';

const logger = createComponentLogger('processor:db-backup');

// `scani-<YYYYMMDD>T<HHMMSS>Z.dump`. This is a CONTRACT, not a convention:
// `scripts/backup-audit.sh` matches exactly `^scani-(\d{8})T(\d{6})Z\.dump$`
// and counts anything else in the bucket as not-a-dump, so a key written in
// any other shape lands safely in R2 and reads to the auditor as a day with
// no backup. Same shape the GitHub workflow and `scripts/backup-db.sh` write,
// which is what keeps one series out of three producers.
function dumpKey(now: Date): string {
  return `scani-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}.dump`;
}

// The dump is buffered in memory to hand to the uploader, on a 1024 MB
// machine that is also running every other job. A dump larger than this would
// OOM the worker — taking pricing, imports and the reconcilers down with it —
// so it refuses instead. The bucket held ~85 MB across 18 dumps and grows
// ~0.3 MB per dump (scripts/backup-db.sh, measured 2026-08-15), so this is
// years away; when it arrives the fix is to stream `Bun.file(path)` straight
// into the S3 client rather than to raise the number.
const MAX_BUFFERED_BYTES = 128 * 1024 * 1024;

// pg_dump writes the archive here first rather than through a pipe: a custom-
// format archive has to be re-read to be verified, and `pg_restore --list` on
// a file is the cheapest proof there is that the bytes are restorable.
const DUMP_DIR = '/tmp';

@Service()
export class DbBackupProcessor extends ScheduledJobProcessor {
  readonly descriptor = DB_BACKUP_SCHEDULE;

  /**
   * Test hook: subclasses can override the config source.
   *
   * Same idiom as `StorageService.env()`. It exists because `loadEnv()` caches
   * process-wide and `process.exit(1)`s on a bad schema — in a suite that runs
   * every file in ONE process, a test that set `BACKUP_BUCKET` after some
   * earlier file had already called it would silently read the old value, and
   * one that set it wrong would take the whole run down.
   */
  protected config(): { databaseUrl: string; bucket: string | undefined } {
    const env = loadEnv();
    return { databaseUrl: env.DATABASE_URL, bucket: env.BACKUP_BUCKET };
  }

  /** Test hook: where the archive is staged before upload. */
  protected dumpDir(): string {
    return DUMP_DIR;
  }

  protected async handle(): Promise<void> {
    const { databaseUrl, bucket } = this.config();
    // Optional in the schema and refused here, the way `weekly-digest` and
    // `alert-sweep` handle FRONTEND_URL (SC-453): the worker runs every
    // scheduled job in one binary, so failing boot over one job's variable
    // stops the hourly pricing and balance jobs too. A refusal an operator can
    // read beats twenty jobs that quietly stopped.
    if (!bucket) {
      throw new Error(
        'db-backup: BACKUP_BUCKET is not set, so there is nowhere to put the dump. ' +
          'It lives in apps/backend/worker/fly.toml under [env] (SC-597) — a value ' +
          'declared only in a GitHub workflow reaches nothing whenever Actions is not running.'
      );
    }

    const startedAt = Date.now();
    const key = dumpKey(new Date());
    const path = `${this.dumpDir()}/${key}`;

    try {
      const bytes = await this.dump(databaseUrl, path);
      const entries = await this.countTableData(path);
      const uploadedAt = Date.now();
      const sha256 = await this.upload(bucket, key, bytes);

      logger.info(
        {
          key,
          bucket,
          bytes: bytes.byteLength,
          tableDataEntries: entries,
          sha256,
          dumpMs: uploadedAt - startedAt,
          uploadMs: Date.now() - uploadedAt,
        },
        '✅ Database backup uploaded and verified in the bucket'
      );
    } finally {
      // A dump left behind fills the machine's root filesystem one day at a
      // time, and the failure that produces is an unrelated job dying on ENOSPC.
      await unlink(path).catch(() => {});
    }
  }

  /** `pg_dump` to `path`, returning the archive bytes. */
  private async dump(databaseUrl: string, path: string): Promise<Uint8Array> {
    // Same flags as `.github/workflows/backup-db.yaml` and
    // `scripts/backup-db.sh`, so the three producers' artefacts stay
    // interchangeable — a restore drill run against one has to mean something
    // about the others.
    //
    // The connection string goes in argv, matching both of those. It is
    // readable from `ps` inside this container, which is single-tenant and
    // runs only our own code; it is never logged and never put in an error
    // message. Splitting it into PG* env vars would keep it out of argv, but
    // requires re-assembling a Neon URI's query parameters by hand, and
    // getting that subtly wrong fails at 06:00 into a job nobody watches.
    const proc = Bun.spawn(
      ['pg_dump', '--format=custom', '--no-owner', '--no-privileges', '--file', path, databaseUrl],
      // `env` is passed explicitly, and it is not decoration: measured
      // 2026-08-29, `Bun.spawn` resolves the executable against the process's
      // ORIGINAL environment and ignores a later `process.env.PATH` write
      // unless `env` is given. Identical in production — this is the same map
      // — and it is what lets the tests put a fake client on PATH and exercise
      // the real argv, exit code and stderr rather than a stub of them.
      { stdout: 'pipe', stderr: 'pipe', env: process.env }
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      // pg_dump's own sentence, not a summary of it. The one that matters most
      // is `aborting because of server version mismatch`, which is what a Neon
      // major upgrade looks like from in here: the client in this image is
      // pinned at 16 (apps/backend/worker/Dockerfile) and refuses a newer
      // server outright. Loud is correct — but only if the reason survives.
      throw new Error(`db-backup: pg_dump exited ${code}: ${stderr.trim() || '(no stderr)'}`);
    }

    const file = Bun.file(path);
    const size = file.size;
    if (size === 0) {
      throw new Error('db-backup: pg_dump exited 0 and wrote an empty archive');
    }
    if (size > MAX_BUFFERED_BYTES) {
      throw new Error(
        `db-backup: archive is ${size} bytes, over the ${MAX_BUFFERED_BYTES}-byte ceiling this ` +
          'job buffers in memory. Stream it instead of raising the ceiling — the worker has 1024 MB ' +
          'and every other job shares it.'
      );
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  /**
   * How many `TABLE DATA` entries the archive contains.
   *
   * An archive that cannot be listed cannot be restored, and uploading one is
   * worse than uploading nothing because it looks like protection. This parses
   * the whole custom-format archive, so it is the cheapest real check there is
   * — and it is a POSITIVE signal: zero entries fails, rather than the absence
   * of an error passing.
   */
  private async countTableData(path: string): Promise<number> {
    const proc = Bun.spawn(['pg_restore', '--list', path], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    const [listing, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(
        `db-backup: pg_restore --list exited ${code}: ${stderr.trim() || '(no stderr)'}`
      );
    }
    const entries = listing.split('\n').filter((line) => line.includes('TABLE DATA')).length;
    if (entries === 0) {
      throw new Error('db-backup: pg_restore --list found no TABLE DATA in the archive');
    }
    return entries;
  }

  /**
   * Upload, then read the object back and compare a sha256 of the BYTES.
   *
   * A write that returned without throwing says a request was answered. It
   * does not say the object is in the bucket, and it is the object that has to
   * be there on the day somebody needs it. Comparing the digest rather than
   * the size, because two dumps of a growing database can share a length.
   */
  private async upload(bucket: string, key: string, bytes: Uint8Array): Promise<string> {
    const storage = Container.get(StorageService);
    await storage.write(key, bytes, 'application/octet-stream', { bucket });

    const back = await storage.read(key, { bucket });
    const local = createHash('sha256').update(bytes).digest('hex');
    const remote = createHash('sha256').update(back).digest('hex');
    if (back.byteLength !== bytes.byteLength || local !== remote) {
      throw new Error(
        `db-backup: read-back of ${key} does not match the dump — ` +
          `${back.byteLength} bytes/${remote} in the bucket, ${bytes.byteLength}/${local} locally`
      );
    }
    return local;
  }
}
