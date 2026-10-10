import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { type BackupFile, BackupWriter } from '../../../src/services/backup/BackupWriter';
import {
  BackupTooLargeError,
  MAX_BACKUP_BYTES,
  UserBackupService,
} from '../../../src/services/backup/UserBackupService';
import { committedRows } from '../../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeUser } from '../../../test/helpers/factories';

restoreContainerAfterAll();

const rows = committedRows();
let file: BackupFile;
let written: Array<{ keyPrefix: string; key: string }>;
let deleted: string[];
let present: Set<string>;
let me: string;
let other: string;

function service(): UserBackupService {
  Container.set(BackupWriter, { file: async () => file } as unknown as BackupWriter);
  Container.set(StorageFacade, {
    writeTemp: async (opts: { keyPrefix: string }) => {
      const key = `temp/${opts.keyPrefix}/${crypto.randomUUID()}.gz`;
      written.push({ keyPrefix: opts.keyPrefix, key });
      present.add(key);
      return key;
    },
    delete: async (key: string) => {
      deleted.push(key);
      present.delete(key);
    },
    exists: async (key: string) => present.has(key),
    presignDownload: async (key: string, ttl: number) => `https://signed.example/${key}?ttl=${ttl}`,
  } as unknown as StorageFacade);
  return new UserBackupService();
}

beforeAll(async () => {
  await getDb().transaction(async (tx) => {
    me = (await makeUser(tx)).id;
    other = (await makeUser(tx)).id;
  });
  rows.users.push(me, other);
});
afterAll(() => rows.drop());

beforeEach(async () => {
  file = {
    bytes: new Uint8Array([1, 2, 3]),
    sha256: 'abc',
    records: 7,
    counts: { holdings: 2 },
  };
  written = [];
  deleted = [];
  present = new Set();
  await getDb().delete(schema.userBackups).where(eq(schema.userBackups.userId, me));
});

describe('UserBackupService (SC-1649)', () => {
  test('stores the file under the account’s backup prefix and records what it wrote', async () => {
    const backup = await service().create(me);

    expect(written).toHaveLength(1);
    expect(written[0]?.keyPrefix).toBe(`backup/${me}`);
    expect(backup).toMatchObject({
      userId: me,
      storageKey: written[0]?.key,
      formatVersion: 1,
      byteSize: 3,
      sha256: 'abc',
      recordCount: 7,
      counts: { holdings: 2 },
    });
  });

  test('a new backup supersedes the last: one row stays, and the old object goes', async () => {
    const svc = service();
    const first = await svc.create(me);
    const second = await svc.create(me);

    const stored = await getDb()
      .select()
      .from(schema.userBackups)
      .where(eq(schema.userBackups.userId, me));
    expect(stored.map((b) => b.id)).toEqual([second.id]);
    expect(deleted).toEqual([first.storageKey]);
    expect((await svc.latest(me))?.id).toBe(second.id);
  });

  test('a file over the limit is refused, and nothing is stored or recorded', async () => {
    file = { ...file, bytes: { byteLength: MAX_BACKUP_BYTES + 1 } as Uint8Array<ArrayBuffer> };

    await expect(service().create(me)).rejects.toBeInstanceOf(BackupTooLargeError);
    expect(written).toEqual([]);
    expect(await service().latest(me)).toBeNull();
  });

  test('a download is signed only for its owner, and an expired object says so', async () => {
    const svc = service();
    const backup = await svc.create(me);

    const ready = await svc.presign(backup.id, me);
    expect(ready.outcome).toBe('ready');
    expect(ready.outcome === 'ready' ? ready.url : '').toBe(
      `https://signed.example/${backup.storageKey}?ttl=300`
    );
    expect((await svc.presign(backup.id, other)).outcome).toBe('not-found');

    present.delete(backup.storageKey);
    expect((await svc.presign(backup.id, me)).outcome).toBe('expired');
  });
});
