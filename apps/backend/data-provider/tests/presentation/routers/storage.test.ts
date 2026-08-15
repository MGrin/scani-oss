import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type PresignedUpload, type PresignUploadOptions, StorageService } from '@scani/storage';
import { Container } from 'typedi';
import { storageRouter } from '../../../src/presentation/routers/storage';
import { buildAuthedContext, buildUnauthedContext } from '../../helpers/test-context';

// Typed against `PresignUploadOptions` / `PresignedUpload` rather than an
// inline shape: the previous fixture answered `{ url, key, fields }`, which
// `StorageService` has never returned, and the `as unknown as` cast below
// hid the drift until the procedure grew an output schema (SC-108).
class FakeStorageService {
  presignUpload = (input: PresignUploadOptions): PresignedUpload => ({
    uploadUrl: `https://fake-presign.test/upload/${input.keyPrefix}/abc.${input.extension}`,
    key: `temp/${input.keyPrefix}/abc.${input.extension}`,
    expiresAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    requiredHeaders: {
      'content-type': input.contentType,
      'content-length': String(input.contentLength),
    },
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
    expect(out.uploadUrl).toContain('uploads/u1');
    expect(out.uploadUrl).toContain('.png');
    expect(out.key).toMatch(/^temp\/uploads\/u1\//);
    expect(out.requiredHeaders['content-type']).toBe('image/png');
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
