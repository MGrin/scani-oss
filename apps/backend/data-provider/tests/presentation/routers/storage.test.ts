import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { StorageService } from '@scani/storage';
import { Container } from 'typedi';
import { storageRouter } from '../../../src/presentation/routers/storage';
import { buildAuthedContext, buildUnauthedContext } from '../../helpers/test-context';

class FakeStorageService {
  presignUpload = (input: {
    keyPrefix: string;
    extension: string;
    contentType: string;
    contentLength: number;
    ttlSeconds?: number;
  }) => ({
    url: `https://fake-presign.test/upload/${input.keyPrefix}/${Date.now()}.${input.extension}`,
    key: `${input.keyPrefix}/abc.${input.extension}`,
    fields: { 'x-content-type': input.contentType },
  });

  presignDownload = (key: string, _ttlSeconds?: number) =>
    `https://fake-presign.test/download/${key}`;
}

class ThrowingStorageService {
  presignUpload = () => {
    throw new Error('R2 unavailable');
  };
  presignDownload = () => {
    throw new Error('R2 unavailable');
  };
}

let previous: StorageService | null;

beforeEach(() => {
  try {
    previous = Container.get(StorageService);
  } catch {
    previous = null;
  }
});

afterEach(() => {
  if (previous) {
    Container.set(StorageService, previous);
  } else {
    Container.remove(StorageService);
  }
});

describe('storageRouter — auth', () => {
  test('rejects unauthed presignUpload', async () => {
    const caller = storageRouter.createCaller(buildUnauthedContext());
    await expect(
      caller.presignUpload({
        keyPrefix: 'uploads/u1',
        extension: 'png',
        contentType: 'image/png',
        contentLength: 1024,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('rejects unauthed presignDownload', async () => {
    const caller = storageRouter.createCaller(buildUnauthedContext());
    await expect(caller.presignDownload({ key: 'uploads/u1/abc.png' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('storageRouter.presignUpload', () => {
  test('returns the signed URL + key from the storage service', async () => {
    Container.set(StorageService, new FakeStorageService() as unknown as StorageService);
    const caller = storageRouter.createCaller(buildAuthedContext());
    const out = await caller.presignUpload({
      keyPrefix: 'uploads/u1',
      extension: 'png',
      contentType: 'image/png',
      contentLength: 1024,
    });
    expect(out.url).toContain('uploads/u1');
    expect(out.url).toContain('.png');
    expect(out.key).toMatch(/^uploads\/u1\//);
  });

  test('maps storage errors to INTERNAL_SERVER_ERROR', async () => {
    Container.set(StorageService, new ThrowingStorageService() as unknown as StorageService);
    const caller = storageRouter.createCaller(buildAuthedContext());
    await expect(
      caller.presignUpload({
        keyPrefix: 'uploads/u1',
        extension: 'png',
        contentType: 'image/png',
        contentLength: 1024,
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('storageRouter.presignDownload', () => {
  test('returns the signed download URL', async () => {
    Container.set(StorageService, new FakeStorageService() as unknown as StorageService);
    const caller = storageRouter.createCaller(buildAuthedContext());
    const out = await caller.presignDownload({ key: 'uploads/u1/abc.png' });
    expect(out.url).toContain('uploads/u1/abc.png');
  });

  test('maps storage errors to INTERNAL_SERVER_ERROR', async () => {
    Container.set(StorageService, new ThrowingStorageService() as unknown as StorageService);
    const caller = storageRouter.createCaller(buildAuthedContext());
    await expect(caller.presignDownload({ key: 'uploads/u1/abc.png' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
