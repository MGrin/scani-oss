import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type PresignedUpload, type PresignUploadOptions, StorageService } from '@scani/storage';
import { Container } from 'typedi';
// This workspace cannot depend on @scani/domain (it sits below it), so the
// shared helper is reached the same way the shared test preload is: by path.
import { restoreContainerAfterAll } from '../../../business/domain/test/helpers/container';
import type { CloudClient } from '../src/client';
import { StorageFacade } from '../src/facades/storage-facade';
import { resetCloudClient, setCloudClient } from '../src/runtime';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface CloudCall {
  op:
    | 'presignUpload'
    | 'presignDownload'
    | 'readTempBlob'
    | 'deleteTempBlob'
    | 'readObject'
    | 'writeObject';
  args: unknown;
}

function stubCloudClient(opts: { deleteThrows?: Error; objectMissing?: boolean } = {}): {
  client: CloudClient;
  calls: CloudCall[];
} {
  const calls: CloudCall[] = [];
  const client = {
    storage: {
      presignUpload: {
        mutate: async (args: unknown) => {
          calls.push({ op: 'presignUpload', args });
          return {
            uploadUrl: 'https://cloud.example/put',
            key: 'temp/cloud/abc.png',
            expiresAt: '2099-01-01T00:00:00.000Z',
            requiredHeaders: { 'content-type': 'image/png' },
          };
        },
      },
      presignDownload: {
        query: async (args: unknown) => {
          calls.push({ op: 'presignDownload', args });
          return { url: 'https://cloud.example/get' };
        },
      },
      readTempBlob: {
        mutate: async (args: unknown) => {
          calls.push({ op: 'readTempBlob', args });
          return { base64: Buffer.from('cloud-bytes').toString('base64'), byteLength: 11 };
        },
      },
      readObject: {
        mutate: async (args: unknown) => {
          calls.push({ op: 'readObject', args });
          if (opts.objectMissing) return { found: false, base64: '', contentType: '' };
          return {
            found: true,
            base64: Buffer.from('cloud-icon').toString('base64'),
            contentType: 'image/png',
          };
        },
      },
      writeObject: {
        mutate: async (args: unknown) => {
          calls.push({ op: 'writeObject', args });
          return { ok: true };
        },
      },
      deleteTempBlob: {
        mutate: async (args: unknown) => {
          calls.push({ op: 'deleteTempBlob', args });
          if (opts.deleteThrows) throw opts.deleteThrows;
          return { ok: true };
        },
      },
    },
  };
  return { client: client as unknown as CloudClient, calls };
}

interface LocalCall {
  op: 'presignUpload' | 'presignDownload' | 'read' | 'delete' | 'readObject' | 'write';
  args: unknown;
}

class StubStorageService extends StorageService {
  calls: LocalCall[] = [];

  override presignUpload(opts: PresignUploadOptions): PresignedUpload {
    this.calls.push({ op: 'presignUpload', args: opts });
    return {
      uploadUrl: 'https://local.example/put',
      key: 'temp/local/xyz.png',
      expiresAt: '2099-01-01T00:00:00.000Z',
      requiredHeaders: { 'content-type': opts.contentType },
    };
  }

  override presignDownload(key: string, ttlSeconds?: number): string {
    this.calls.push({ op: 'presignDownload', args: { key, ttlSeconds } });
    return 'https://local.example/get';
  }

  override async read(key: string): Promise<Buffer> {
    this.calls.push({ op: 'read', args: { key } });
    return Buffer.from('local-bytes');
  }

  override async delete(key: string): Promise<void> {
    this.calls.push({ op: 'delete', args: { key } });
  }

  override async readObject(
    key: string
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    this.calls.push({ op: 'readObject', args: { key } });
    return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/gif' };
  }

  override async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.calls.push({ op: 'write', args: { key, byteLength: bytes.byteLength, contentType } });
  }
}

let stubLocal: StubStorageService;
beforeEach(() => {
  stubLocal = new StubStorageService();
  // Standard stubbed-DI pattern: seed Container before constructing facade.
  Container.set(StorageService, stubLocal);
  // Default to local-only mode. Cloud-mode tests override via setCloudClient.
  // We use setCloudClient(null) instead of resetCloudClient() because the
  // host shell may have SCANI_CLOUD_URL set, and reset would re-read env.
  setCloudClient(null);
});
afterEach(() => {
  resetCloudClient();
});

describe('StorageFacade — local mode (no cloud client)', () => {
  test('presignUpload routes to the local StorageService', async () => {
    const facade = new StorageFacade();
    const out = await facade.presignUpload({
      keyPrefix: 'screenshot/u1',
      extension: 'png',
      contentType: 'image/png',
      contentLength: 1024,
    });
    expect(out.uploadUrl).toBe('https://local.example/put');
    expect(stubLocal.calls).toEqual([
      {
        op: 'presignUpload',
        args: {
          keyPrefix: 'screenshot/u1',
          extension: 'png',
          contentType: 'image/png',
          contentLength: 1024,
        },
      },
    ]);
  });

  test('presignDownload routes to the local StorageService', async () => {
    const facade = new StorageFacade();
    const url = await facade.presignDownload('temp/foo/abc.png', 30);
    expect(url).toBe('https://local.example/get');
    expect(stubLocal.calls[0]).toEqual({
      op: 'presignDownload',
      args: { key: 'temp/foo/abc.png', ttlSeconds: 30 },
    });
  });

  test('read routes to the local StorageService', async () => {
    const facade = new StorageFacade();
    const buf = await facade.read('temp/foo/abc.png');
    expect(buf.toString('utf-8')).toBe('local-bytes');
    expect(stubLocal.calls[0]).toEqual({ op: 'read', args: { key: 'temp/foo/abc.png' } });
  });

  test('delete routes to the local StorageService', async () => {
    const facade = new StorageFacade();
    await facade.delete('temp/foo/abc.png');
    expect(stubLocal.calls[0]).toEqual({ op: 'delete', args: { key: 'temp/foo/abc.png' } });
  });

  test('readObject routes to the local StorageService, with the type', async () => {
    const facade = new StorageFacade();
    const out = await facade.readObject('institution-icons/abc');
    expect(out?.contentType).toBe('image/gif');
    expect(stubLocal.calls[0]).toEqual({
      op: 'readObject',
      args: { key: 'institution-icons/abc' },
    });
  });

  test('write routes to the local StorageService', async () => {
    const facade = new StorageFacade();
    await facade.write('institution-icons/abc', new Uint8Array([9, 9]), 'image/png');
    expect(stubLocal.calls[0]).toEqual({
      op: 'write',
      args: { key: 'institution-icons/abc', byteLength: 2, contentType: 'image/png' },
    });
  });
});

describe('StorageFacade — cloud mode (cloud client set)', () => {
  test('presignUpload routes to the cloud client and the local stub is untouched', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new StorageFacade();
    const out = await facade.presignUpload({
      keyPrefix: 'screenshot/u1',
      extension: 'png',
      contentType: 'image/png',
      contentLength: 1024,
    });
    expect(out.uploadUrl).toBe('https://cloud.example/put');
    expect(calls[0]?.op).toBe('presignUpload');
    expect(stubLocal.calls).toHaveLength(0);
  });

  test('presignDownload routes to the cloud client', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new StorageFacade();
    const url = await facade.presignDownload('key', 60);
    expect(url).toBe('https://cloud.example/get');
    expect(calls[0]).toEqual({ op: 'presignDownload', args: { key: 'key', ttlSeconds: 60 } });
    expect(stubLocal.calls).toHaveLength(0);
  });

  test('read routes to the cloud client and base64-decodes the response', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new StorageFacade();
    const buf = await facade.read('temp/cloud/k.png');
    expect(buf.toString('utf-8')).toBe('cloud-bytes');
    expect(calls[0]).toEqual({ op: 'readTempBlob', args: { key: 'temp/cloud/k.png' } });
    expect(stubLocal.calls).toHaveLength(0);
  });

  test('delete routes to the cloud client', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new StorageFacade();
    await facade.delete('temp/cloud/k.png');
    expect(calls[0]).toEqual({ op: 'deleteTempBlob', args: { key: 'temp/cloud/k.png' } });
    expect(stubLocal.calls).toHaveLength(0);
  });

  test('delete swallows 404 / NoSuchKey from the cloud client (lifecycle race)', async () => {
    const { client } = stubCloudClient({ deleteThrows: new Error('NoSuchKey: not found') });
    setCloudClient(client);

    const facade = new StorageFacade();
    await expect(facade.delete('key')).resolves.toBeUndefined();
  });

  test('delete swallows the message R2 actually sends for a missing key', async () => {
    // The predicate here used to be /NoSuchKey|404|not found/i, which
    // matches none of the words in R2's real wording. It only looked
    // correct because the data-provider swallows the raw `NoSuchKey`
    // server-side first — so the client-side guard was never the thing
    // holding, and would have thrown the moment it was reached.
    const { client } = stubCloudClient({
      deleteThrows: new Error('The specified key does not exist.'),
    });
    setCloudClient(client);

    const facade = new StorageFacade();
    await expect(facade.delete('key')).resolves.toBeUndefined();
  });

  test('delete propagates non-404 errors from the cloud client', async () => {
    const { client } = stubCloudClient({ deleteThrows: new Error('500 internal') });
    setCloudClient(client);

    const facade = new StorageFacade();
    await expect(facade.delete('key')).rejects.toThrow(/500/);
  });

  test('readObject routes to the cloud client and decodes the base64 (SC-208)', async () => {
    // The api reaches R2 through the data-provider in production, so this is
    // the path institution icons actually take — the local branch above is
    // the OSS / dev one.
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new StorageFacade();
    const out = await facade.readObject('institution-icons/abc');
    expect(out?.contentType).toBe('image/png');
    expect(Buffer.from(out?.bytes ?? new Uint8Array()).toString('utf-8')).toBe('cloud-icon');
    expect(calls[0]).toEqual({ op: 'readObject', args: { key: 'institution-icons/abc' } });
    expect(stubLocal.calls).toHaveLength(0);
  });

  test('a missing object is null, NOT a throw and NOT empty bytes', async () => {
    // Both wrong answers are load-bearing. A throw would make an ordinary
    // first-ever request look like an outage; zero-length bytes would be
    // served as a 200 that decodes to nothing, and the caller would cache
    // that for a day.
    const { client } = stubCloudClient({ objectMissing: true });
    setCloudClient(client);

    const facade = new StorageFacade();
    await expect(facade.readObject('institution-icons/nope')).resolves.toBeNull();
  });

  test('write routes to the cloud client as base64', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);

    const facade = new StorageFacade();
    await facade.write('institution-icons/abc', new Uint8Array([0x89, 0x50]), 'image/png');
    expect(calls[0]).toEqual({
      op: 'writeObject',
      args: {
        key: 'institution-icons/abc',
        base64: Buffer.from([0x89, 0x50]).toString('base64'),
        contentType: 'image/png',
      },
    });
    expect(stubLocal.calls).toHaveLength(0);
  });
});

describe('StorageFacade — caching', () => {
  test('the cloud check fires only once across many calls', async () => {
    const { client, calls } = stubCloudClient();
    setCloudClient(client);
    const facade = new StorageFacade();

    await facade.read('a');
    await facade.read('b');
    await facade.delete('a');

    // Each call hit the cloud client (proves the cached cloud handle is used).
    expect(calls).toHaveLength(3);
  });

  test('local-mode resolution is also cached after first call', async () => {
    const facade = new StorageFacade();
    await facade.read('a');
    await facade.read('b');
    expect(stubLocal.calls).toHaveLength(2);
  });
});
