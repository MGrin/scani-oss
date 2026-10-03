import { describe, expect, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { UPLOADED_FILE_MAX_BYTES } from '@scani/shared';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

/**
 * SC-1399. No AI provider here reads HEIC, so an image the server accepted as
 * HEIC could only fail later, at parse. The upload is where it is refused now.
 */
describe('storage.getUploadUrl image types (SC-1399)', () => {
  function caller() {
    Container.set(StorageFacade, {
      async presignUpload() {
        return {
          uploadUrl: 'https://s3.test/put',
          key: 'k',
          expiresAt: new Date(),
          requiredHeaders: {},
        };
      },
    } as unknown as StorageFacade);
    return makeAuthedCaller({
      id: crypto.randomUUID(),
      email: 'types@example.invalid',
    } as schema.User);
  }

  for (const purpose of ['screenshot', 'document'] as const) {
    test(`${purpose}: a HEIC or HEIF image is refused`, async () => {
      const c = caller();
      for (const [contentType, filename] of [
        ['image/heic', 'photo.heic'],
        ['image/heif', 'photo.heif'],
      ] as const) {
        await expect(
          c.storage.getUploadUrl({ purpose, contentType, filename, sizeBytes: 1_000 })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
    });

    test(`${purpose}: control, a JPEG is still accepted`, async () => {
      const res = await caller().storage.getUploadUrl({
        purpose,
        contentType: 'image/jpeg',
        filename: 'photo.jpg',
        sizeBytes: 1_000,
      });
      expect(res.method).toBe('PUT');
    });
  }
});

/**
 * SC-1492. Past the upload limit the refusal used to be zod's issue list, which
 * the app will not show a reader, so a client that skipped its own check said
 * only that something went wrong. It is a sentence now.
 */
describe('storage.getUploadUrl size (SC-1492)', () => {
  function caller() {
    Container.set(StorageFacade, {
      async presignUpload() {
        return {
          uploadUrl: 'https://s3.test/put',
          key: 'k',
          expiresAt: new Date(),
          requiredHeaders: {},
        };
      },
    } as unknown as StorageFacade);
    return makeAuthedCaller({
      id: crypto.randomUUID(),
      email: 'size@example.invalid',
    } as schema.User);
  }

  const input = { purpose: 'document', contentType: 'application/pdf', filename: 'a.pdf' } as const;

  test('a file over the limit is refused in words, naming its size and the limit', async () => {
    await expect(
      caller().storage.getUploadUrl({ ...input, sizeBytes: 13_002_342 })
    ).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'This file is 12.4 MB. The limit is 8 MB.',
    });
  });

  test('control: a file of exactly the limit is accepted', async () => {
    const res = await caller().storage.getUploadUrl({
      ...input,
      sizeBytes: UPLOADED_FILE_MAX_BYTES,
    });
    expect(res.method).toBe('PUT');
  });
});
