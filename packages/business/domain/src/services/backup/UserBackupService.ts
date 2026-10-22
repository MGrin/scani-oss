import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { getDb } from '@scani/db';
import type { UserBackup } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { BACKUP_UPLOAD_MAX_BYTES, UPLOADED_FILE_MAX_BYTES } from '@scani/shared';
import { and, desc, eq, ne } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { type BackupFileSource, BackupWriter } from './BackupWriter';
import { BACKUP_VERSION } from './backup-plan';

/** Long enough to start a download on a slow connection, short enough that a leaked URL dies fast. */
const DOWNLOAD_TTL_SECONDS = 5 * 60;

/**
 * The worker holds the compressed file in memory before it stores it. The
 * largest account measured compresses from about 99 MB of row JSON, so this
 * is far above any real account and below what would take the worker down.
 */
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

export class BackupTooLargeError extends Error {
  constructor(readonly byteSize: number) {
    super(`The backup is ${byteSize} bytes, over the ${MAX_BACKUP_BYTES}-byte limit`);
    this.name = 'BackupTooLargeError';
  }
}

export type BackupDownloadOutcome =
  /** Doesn't exist, or belongs to another account; the caller must not distinguish them. */
  | { outcome: 'not-found' }
  /** `temp/` expired it; the person makes a new one. */
  | { outcome: 'expired'; backup: UserBackup }
  | { outcome: 'ready'; backup: UserBackup; url: string; expiresAt: Date };

/**
 * A person's backup (SC-1649): built by `BackupWriter`, stored under
 * `temp/backup/<userId>/`, recorded in `user_backups` so deleting the account
 * deletes it. An account keeps one backup; a new one supersedes the last.
 */
@Service()
export class UserBackupService {
  private readonly logger = createComponentLogger('service:UserBackupService');
  private readonly writer = Container.get(BackupWriter);
  private readonly storage = Container.get(StorageFacade);

  async create(userId: string): Promise<UserBackup & { counts: Record<string, number> }> {
    const files: BackupFileSource = {
      exists: (key) => this.storage.exists(key),
      read: (key) => this.storage.read(key, { maxBytes: UPLOADED_FILE_MAX_BYTES }),
    };
    let file = await this.writer.file(userId, getDb(), files);
    // A backup the restore would refuse is no backup. When the files are what
    // takes it past the restore's limit, build it again without them, and the
    // Backup card says how many were left out (SC-1662).
    if (file.bytes.byteLength > BACKUP_UPLOAD_MAX_BYTES && file.filesIncluded > 0) {
      this.logger.info(
        { userId, bytes: file.bytes.byteLength, files: file.filesIncluded },
        'Backup with files is over the restore limit; building it without them'
      );
      file = await this.writer.file(userId, getDb(), null);
    }
    if (file.bytes.byteLength > MAX_BACKUP_BYTES) {
      throw new BackupTooLargeError(file.bytes.byteLength);
    }
    const storageKey = await this.storage.writeTemp(
      { keyPrefix: `backup/${userId}`, extension: 'gz', contentType: 'application/gzip' },
      file.bytes
    );

    const { backup, superseded } = await getDb().transaction(async (tx) => {
      const [backup] = await tx
        .insert(schema.userBackups)
        .values({
          userId,
          storageKey,
          formatVersion: BACKUP_VERSION,
          byteSize: file.bytes.byteLength,
          sha256: file.sha256,
          recordCount: file.records,
          filesLeftOut: file.filesLeftOut,
        })
        .returning();
      if (!backup) throw new Error('UserBackupService: the backup row was not written');
      const superseded = await tx
        .delete(schema.userBackups)
        .where(and(eq(schema.userBackups.userId, userId), ne(schema.userBackups.id, backup.id)))
        .returning({ storageKey: schema.userBackups.storageKey });
      return { backup, superseded };
    });

    // After the commit, as the account deletion does: a failed delete leaves
    // an object with no row, which `temp/` expires, and never a row with no object.
    for (const { storageKey: key } of superseded) {
      await this.storage.delete(key).catch((error: unknown) =>
        this.logger.warn(
          {
            userId,
            storageKey: key,
            error: error instanceof Error ? error.message : String(error),
          },
          'A superseded backup object was not deleted; temp/ expires it'
        )
      );
    }
    this.logger.info(
      { userId, backupId: backup.id, bytes: backup.byteSize, records: backup.recordCount },
      'Backup stored'
    );
    return { ...backup, counts: file.counts };
  }

  async latest(userId: string): Promise<UserBackup | null> {
    const [backup] = await getDb()
      .select()
      .from(schema.userBackups)
      .where(eq(schema.userBackups.userId, userId))
      .orderBy(desc(schema.userBackups.createdAt))
      .limit(1);
    return backup ?? null;
  }

  async presign(backupId: string, userId: string): Promise<BackupDownloadOutcome> {
    const [backup] = await getDb()
      .select()
      .from(schema.userBackups)
      .where(and(eq(schema.userBackups.id, backupId), eq(schema.userBackups.userId, userId)));
    if (!backup) return { outcome: 'not-found' };
    if (!(await this.storage.exists(backup.storageKey))) return { outcome: 'expired', backup };
    const url = await this.storage.presignDownload(backup.storageKey, DOWNLOAD_TTL_SECONDS);
    return {
      outcome: 'ready',
      backup,
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000),
    };
  }
}
